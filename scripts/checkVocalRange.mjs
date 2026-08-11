#!/usr/bin/env node
// Offline check for src/common/vocalRange.ts, following the pattern in
// scripts/replayScoring.mjs: compile the real modules and drive them, rather
// than reimplementing the logic (a reimplementation drifts and then the check
// measures the wrong thing).
//
// The load-bearing claim under test: unfolded target-anchored acceptance
// rejects octave errors and room rumble, which is exactly what a song take
// cannot do. Case 3 and 4 fail loudly if that stops being true.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function compile() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_range"));
  execFileSync(
    "corepack",
    [
      "yarn",
      "tsc",
      "src/common/vocalRange.ts",
      "src/common/tuningExercise.ts",
      "src/common/scoring.ts",
      "src/common/scoringData.ts",
      "src/common/guideMelody.ts",
      "--outDir",
      outDir,
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
    ],
    { cwd: REPO, stdio: "pipe" },
  );
  // .mjs for the same reason replayScoring.mjs does it: no package.json in the
  // temp dir, so Node would read .js as CommonJS and trip the import-cycle
  // guard. tsc emits extensionless specifiers, hence the rewrite.
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith(".js")) continue;
    const p = path.join(outDir, file);
    fs.writeFileSync(
      p.replace(/\.js$/, ".mjs"),
      fs
        .readFileSync(p, "utf8")
        .replace(/from "\.\/([^".]+)"/g, 'from "./$1.mjs"'),
    );
    fs.rmSync(p);
  }
  return outDir;
}

const outDir = compile();
const {
  estimateVocalRange,
  songRangeFromScoringData,
  suggestKeyShift,
  sitsComfortably,
  songOctaveShiftFor,
} = await import(path.join(outDir, "vocalRange.mjs"));
const { parseScoringData } = await import(path.join(outDir, "scoringData.mjs"));
const { buildTuningExercise, midiToNoteName } = await import(
  path.join(outDir, "tuningExercise.mjs")
);
const { signedOctaveFoldedDeviation } = await import(
  path.join(outDir, "scoring.mjs")
);
const { buildScoringData } = await import(path.join(outDir, "guideMelody.mjs"));

// The fit functions take a duration-weighted pitch histogram, which is what the
// server caches per song -- so these checks exercise exactly the shape the app
// asks the questions with.
function hist(scoringData) {
  return songRangeFromScoringData(scoringData).histogram;
}

const HOP_MS = 10; // the real detector hop

// Emit samples across a target's whole span at `pitchOf(target)`, or nothing
// when pitchOf returns null (silence).
function trace(exercise, pitchOf) {
  const samples = [];
  for (const target of exercise.targets) {
    const midi = pitchOf(target);
    if (midi === null) continue;
    for (let t = target.startTime; t < target.endTime; t += HOP_MS / 1000) {
      samples.push({
        timeSecs: t,
        midiNumber: midi,
        pitchShiftSemis: 0,
        rms: 0.1,
      });
    }
  }
  return samples;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}: got ${JSON.stringify(actual)}${
      ok ? "" : ` want ${JSON.stringify(expected)}`
    }`,
  );
}

const exercise = buildTuningExercise();
console.log(
  `exercise: centre ${midiToNoteName(exercise.centreMidi)}, ` +
    `${exercise.floorMidi}..${exercise.ceilingMidi} ` +
    `(${midiToNoteName(exercise.floorMidi)}..${midiToNoteName(exercise.ceilingMidi)}), ` +
    `${exercise.targets.length} targets, ${exercise.durationSecs.toFixed(1)}s\n`,
);

// 1. Sings every target dead on.
{
  const result = estimateVocalRange(
    exercise.targets,
    trace(exercise, (t) => t.midiNumber),
    0,
  );
  console.log("case 1: perfect singer");
  check("low", result.lowMidi, exercise.floorMidi);
  check("high", result.highMidi, exercise.ceilingMidi);
  check("comfortable low", result.comfortableLowMidi, exercise.floorMidi);
  check("comfortable high", result.comfortableHighMidi, exercise.ceilingMidi);
  check("hitFloor", result.hitFloor, true);
  check("hitCeiling", result.hitCeiling, true);
}

// 2. Only comfortable in the middle; silent outside it.
{
  const LO = 52;
  const HI = 68;
  const result = estimateVocalRange(
    exercise.targets,
    trace(exercise, (t) =>
      t.midiNumber >= LO && t.midiNumber <= HI ? t.midiNumber : null,
    ),
    0,
  );
  const inBand = exercise.targets
    .filter((t) => t.phase !== "settle")
    .map((t) => t.midiNumber)
    .filter((m) => m >= LO && m <= HI);
  console.log("\ncase 2: limited singer, silent outside 52..68");
  check("low", result.lowMidi, Math.min(...inBand));
  check("high", result.highMidi, Math.max(...inBand));
  check("hitFloor", result.hitFloor, false);
  check("hitCeiling", result.hitCeiling, false);
}

// 3. THE case. Every low target sung (or tracked) an octave down.
{
  const result = estimateVocalRange(
    exercise.targets,
    trace(exercise, (t) =>
      t.phase === "descend" ? t.midiNumber - 12 : t.midiNumber,
    ),
    0,
  );
  const ascendOnly = exercise.targets
    .filter((t) => t.phase === "ascend")
    .map((t) => t.midiNumber);
  console.log("\ncase 3: octave-displaced low notes must NOT be credited");
  check(
    "no descend target reached",
    result.targets.filter((o) => o.phase === "descend" && o.reached).length,
    0,
  );
  check(
    "low is the lowest ascend target",
    result.lowMidi,
    Math.min(...ascendOnly),
  );
  // And the proof that folding would have swallowed it whole:
  const folded = signedOctaveFoldedDeviation(48, 60);
  check("scoring's folded deviation for a -12 error", folded, 0);
  console.log(
    "        ^ octave-folded deviation is 0, i.e. scoring credits it as perfect.",
  );
  console.log(
    "          That is correct for scoring and fatal for range; hence the unfolded gate.",
  );
}

// 4. Room rumble: a constant low tone through the whole exercise.
{
  const result = estimateVocalRange(
    exercise.targets,
    trace(exercise, () => 43),
    0,
  );
  console.log(
    "\ncase 4: constant MIDI 43 rumble (the documented corpus failure)",
  );
  // 43 is only within tolerance of a target at 42..44; the exercise's floor is
  // 44 for the mixed preset, so at most that one target may credit it.
  const credited = result.targets
    .filter((o) => o.reached)
    .map((o) => o.midiNumber);
  check("nothing below 42 credited", credited.filter((m) => m < 42).length, 0);
  console.log(`        credited targets: ${JSON.stringify(credited)}`);
}

// 5. Sustain gate: on target, but only 200ms of it.
{
  const samples = [];
  for (const target of exercise.targets) {
    for (
      let t = target.startTime + 0.3;
      t < target.startTime + 0.5;
      t += HOP_MS / 1000
    ) {
      samples.push({
        timeSecs: t,
        midiNumber: target.midiNumber,
        pitchShiftSemis: 0,
        rms: 0.1,
      });
    }
  }
  const result = estimateVocalRange(exercise.targets, samples, 0);
  console.log("\ncase 5: 200ms per target is below the 300ms sustain gate");
  check("nothing reached", result.targets.filter((o) => o.reached).length, 0);
  check("range is null", result.lowMidi, null);
}

// Builds a song of `spread` semitones starting at `lowMidi`, 40 notes.
function song(lowMidi, spread) {
  return Array.from(
    buildScoringData(
      Array.from({ length: 40 }, (_, i) => ({
        startMs: i * 1000,
        endMs: i * 1000 + 800,
        midi: lowMidi + (i % (spread + 1)),
      })),
    ),
  );
}

// 6. Octave normalisation. THE real-world case: measured across 56 song/take
// pairs, the extracted JOYSOUND melody sits an octave above the singer on 33
// and two octaves above on 20 -- only 3 share the singer's octave. A song
// written two octaves up must still read as comfortable, because the singer
// simply sings it where it suits them.
{
  const band = { comfortableLowMidi: 55, comfortableHighMidi: 69 };
  const atPitch = song(58, 8); // 58..66, squarely inside the band
  const twoOctavesUp = song(58 + 24, 8); // the same song as JOYSOUND stores it

  console.log(
    "\ncase 6: a melody stored 2 octaves high is still the same song",
  );
  check("at pitch: comfortable", sitsComfortably(hist(atPitch), band), true);
  check(
    "2 octaves up: comfortable",
    sitsComfortably(hist(twoOctavesUp), band),
    true,
  );
  check("at pitch: no suggestion", suggestKeyShift(hist(atPitch), band), null);
  check(
    "2 octaves up: no suggestion",
    suggestKeyShift(hist(twoOctavesUp), band),
    null,
  );
  check(
    "octave shift chosen",
    songOctaveShiftFor(hist(twoOctavesUp), band),
    -24,
  );
  // Absolute range is reported raw -- it is an honest reading of the data, and
  // normalisation is a property of the singer, not the song.
  check(
    "raw song range is unnormalised",
    songRangeFromScoringData(twoOctavesUp).lowMidi,
    82,
  );
}

// 7. A song whose shape genuinely doesn't suit a narrow band, where a semitone
// shift does help. This is the case a suggestion exists for.
{
  const band = { comfortableLowMidi: 55, comfortableHighMidi: 64 }; // 10 semitones
  // 14 semitones wide, sitting so its top half spills past the band.
  const data = song(60, 14); // 60..74, normalises down 12 -> 48..62
  const suggestion = suggestKeyShift(hist(data), band);
  console.log("\ncase 7: narrow band, song spilling out of it");
  check("not marked comfortable", sitsComfortably(hist(data), band), false);
  check("a suggestion is offered", suggestion !== null, true);
  if (suggestion) {
    check(
      "lands somewhere genuinely good",
      suggestion.comfortableFractionAtShift >= 0.6,
      true,
    );
    check(
      "is a real improvement",
      suggestion.comfortableFractionAtShift -
        suggestion.comfortableFractionAtZero >=
        0.12,
      true,
    );
    check("within +/-6 semitones", Math.abs(suggestion.semis) <= 6, true);
    console.log(`        suggestion: ${JSON.stringify(suggestion)}`);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
console.log(
  `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
