#!/usr/bin/env node
// Re-calibrates the suggestion thresholds WITH octave normalisation, and checks
// how often each surface would actually fire across the 54 cached melodies.
//
// What we need to know:
//   * COMFORTABLE_ENOUGH: how often does the positive marker appear? Too high
//     and it never shows; too low and every song is "comfortable" and it means
//     nothing.
//   * SUGGESTION_WORTH_MAKING / MEANINGFUL_IMPROVEMENT: how often does a key
//     offer appear, and is it landing somewhere good when it does?

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MELODY_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Electron/melodies",
);

function compile() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_cal2"));
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
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith(".js")) continue;
    const p = path.join(outDir, f);
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
  songOctaveShiftFor,
  sitsComfortably,
  suggestKeyShift,
  songRangeFromScoringData,
} = await import(path.join(outDir, "vocalRange.mjs"));
const { parseScoringData } = await import(path.join(outDir, "scoringData.mjs"));
const { midiToNoteName } = await import(
  path.join(outDir, "tuningExercise.mjs")
);

// The fit functions take a duration-weighted pitch histogram, which is what the
// server caches per song, so these checks exercise exactly the shape the app
// asks the questions with.
function hist(scoringData) {
  return songRangeFromScoringData(scoringData).histogram;
}

function fractionInBand(notes, band, shift) {
  let inside = 0,
    total = 0;
  for (const n of notes) {
    const d = n.endTime - n.startTime;
    if (d <= 0) continue;
    total += d;
    const m = n.midiNumber + shift;
    if (m >= band.comfortableLowMidi && m <= band.comfortableHighMidi)
      inside += d;
  }
  return total > 0 ? inside / total : 0;
}

const songs = [];
for (const file of fs.readdirSync(MELODY_DIR)) {
  if (!file.endsWith("-melody.bin")) continue;
  const data = Array.from(fs.readFileSync(path.join(MELODY_DIR, file)));
  const { notes } = parseScoringData(data);
  if (notes.length < 24) continue;
  songs.push({ id: file.replace(/joysound-|-melody\.bin/g, ""), data, notes });
}

const pct = (arr, p) =>
  [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)];

// Bands representing plausible measured results from the exercise: a narrow
// comfortable band, a typical one, a wide one.
const BANDS = [
  {
    label: "narrow  (10st, C3-A3)",
    comfortableLowMidi: 48,
    comfortableHighMidi: 58,
  },
  {
    label: "typical (14st, G3-A4)",
    comfortableLowMidi: 55,
    comfortableHighMidi: 69,
  },
  {
    label: "wide    (18st, F3-B4)",
    comfortableLowMidi: 53,
    comfortableHighMidi: 71,
  },
];

console.log(`${songs.length} melodies, octave-normalised per band\n`);

for (const band of BANDS) {
  const atZero = [];
  const bests = [];
  let comfortable = 0;
  let suggested = 0;
  const suggestedFracs = [];
  const suggestedSemis = [];

  for (const s of songs) {
    const octave = songOctaveShiftFor(hist(s.data), band);
    const f0 = fractionInBand(s.notes, band, octave);
    atZero.push(f0);
    let best = f0;
    for (let k = -6; k <= 6; k++) {
      best = Math.max(best, fractionInBand(s.notes, band, octave + k));
    }
    bests.push(best);
    if (sitsComfortably(hist(s.data), band)) comfortable++;
    const sug = suggestKeyShift(hist(s.data), band);
    if (sug) {
      suggested++;
      suggestedFracs.push(sug.comfortableFractionAtShift);
      suggestedSemis.push(sug.semis);
    }
  }

  console.log(`${band.label}`);
  console.log(
    `  fraction in band at written key: p10 ${pct(atZero, 0.1).toFixed(2)} ` +
      `p25 ${pct(atZero, 0.25).toFixed(2)} med ${pct(atZero, 0.5).toFixed(2)} ` +
      `p75 ${pct(atZero, 0.75).toFixed(2)} p90 ${pct(atZero, 0.9).toFixed(2)}`,
  );
  console.log(
    `  best within +/-6 semitones:      p10 ${pct(bests, 0.1).toFixed(2)} ` +
      `p25 ${pct(bests, 0.25).toFixed(2)} med ${pct(bests, 0.5).toFixed(2)} ` +
      `p75 ${pct(bests, 0.75).toFixed(2)} p90 ${pct(bests, 0.9).toFixed(2)}`,
  );
  console.log(
    `  -> "sits comfortably" marker: ${comfortable}/${songs.length} songs ` +
      `(${((comfortable / songs.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  -> key offer shown:           ${suggested}/${songs.length} songs ` +
      `(${((suggested / songs.length) * 100).toFixed(0)}%)` +
      (suggested > 0
        ? `, landing at median ${pct(suggestedFracs, 0.5).toFixed(2)} in band, ` +
          `median shift ${pct(suggestedSemis.map(Math.abs), 0.5)} semitones`
        : ""),
  );
  console.log(
    `  -> neither (stays silent):    ${songs.length - comfortable - suggested}/${songs.length}\n`,
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
