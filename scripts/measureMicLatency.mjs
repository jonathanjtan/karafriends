#!/usr/bin/env node
// Finds the mic latency compensation that best fits a real sung performance,
// for setting config.yaml's micLatencyCalibrationMs.
//
// The compensation differs per machine and audio backend, and on macOS the OS
// does not report the input path truthfully, so it can't be derived at
// runtime -- it has to be measured. This sweeps the compensation over a
// recorded (videoTime, midiNumber) sample stream and reports which offset
// maximises the score the real ScoreAccumulator produces.
//
// The sweep result is the *total* compensation. config.yaml wants the
// calibration part only: subtract the live output term the app adds at runtime
// (AudioContext.outputLatency, ~25ms) from this number before setting it.
//
// Every latency term is captured at once -- output path, input capture, the
// detector's window centre, anything unenumerated -- because the singer's
// alignment against the guide melody is the only thing being optimised.
//
// Capturing a take: set localStorage.pitchProbe = "1" in the renderer's
// devtools console, sing one song full-voice without seeking, and let it end.
// Each accepted pitch sample is logged as PROBE_PITCH <videoTime> <midi>
// <shift>; capture the run's stdout to a file and pass it as --log. The melody
// is the cached karafriends_tmp/joysound-<songId>-melody.bin for that song.
//
// Accuracy, measured against synthetic traces with a known lateness baked in
// (0 / 60 / 120ms, real melody, 25ms polling): the estimate came back 8.75ms
// low each time. The bias is structural -- a compensation slightly *under*
// the truth still lands every sample inside its note, while one slightly over
// pushes the first sample of each note in front of its onset, so the flat top
// extends further below the true value than above it. Read the answer as
// +/-15ms and lean towards the high end of the plateau. That is ample for
// deciding between "about 40ms" and "about 65ms"; it is not a calibration
// good to the millisecond.
//
// Usage:
//   node scripts/measureMicLatency.mjs --log <electron.log> --melody <melody.bin>
//
// The log is anything containing the PROBE_PITCH lines PianoRoll's pollPitch
// emits when localStorage.pitchProbe is set; the melody is the cached
// karafriends_tmp/joysound-<songId>-melody.bin for the song that was sung.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Sweep range. Latency this large would be pathological (Bluetooth output is
// the usual way to get near the top of it), but the curve's shape either side
// of the peak is what tells you the peak is real rather than noise.
const MAX_COMPENSATION_MS = 250;
const STEP_MS = 2.5;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--")) continue;
    out[args[i].slice(2)] = args[i + 1];
  }
  if (!out.log || !out.melody) {
    console.error(
      "usage: node scripts/measureMicLatency.mjs --log <electron.log> --melody <melody.bin>",
    );
    process.exit(1);
  }
  return out;
}

// scoring.ts is TypeScript and lives under Yarn PnP; compiling it to plain JS
// in a temp dir is far less trouble than getting a .ts import to resolve here,
// and it keeps the sweep honest by running the very code the app scores with
// rather than a reimplementation that could drift.
function compileScoring() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_sweep"));
  execFileSync(
    "corepack",
    [
      "yarn",
      "tsc",
      "src/common/scoring.ts",
      "src/common/scoringData.ts",
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
  // tsc emits extensionless relative specifiers, which Node's ESM loader
  // rejects.
  for (const file of fs.readdirSync(outDir)) {
    const p = path.join(outDir, file);
    fs.writeFileSync(
      p,
      fs
        .readFileSync(p, "utf8")
        .replace(/from "\.\/([^".]+)"/g, 'from "./$1.js"'),
    );
  }
  return outDir;
}

function readSamples(logPath) {
  const samples = [];
  const shifts = new Set();
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    const m = line.match(/PROBE_PITCH (-?[\d.]+) (-?[\d.]+) (-?\d+)/);
    if (!m) continue;
    samples.push({ t: parseFloat(m[1]), midi: parseFloat(m[2]) });
    shifts.add(parseInt(m[3], 10));
  }
  return { samples, shifts: [...shifts] };
}

const args = parseArgs();
const outDir = compileScoring();
const { ScoreAccumulator } = await import(path.join(outDir, "scoring.js"));
const { parseScoringData } = await import(path.join(outDir, "scoringData.js"));

const { samples, shifts } = readSamples(args.log);
if (samples.length === 0) {
  console.error(`No PROBE_PITCH lines in ${args.log}.`);
  process.exit(1);
}
if (shifts.length > 1) {
  console.error(
    `Pitch shift changed mid-song (${shifts.join(", ")}); the sweep assumes one value.`,
  );
  process.exit(1);
}
const pitchShiftSemis = shifts[0] ?? 0;

const { notes, lyricsIntervals } = parseScoringData(
  Array.from(fs.readFileSync(args.melody)),
);

console.log(
  `${samples.length} samples spanning ${samples[0].t.toFixed(1)}-${samples[samples.length - 1].t.toFixed(1)}s`,
);
console.log(
  `${notes.length} reference notes, pitchShiftSemis=${pitchShiftSemis}\n`,
);

// The accumulator's own compensation defaults to 0 when unset, so shifting the
// timestamp here is exactly equivalent to configuring it -- this sweeps the
// total the app would need, whatever the config currently holds.
function scoreAt(compensationMs) {
  const accumulator = new ScoreAccumulator(notes, lyricsIntervals);
  for (const { t, midi } of samples) {
    accumulator.addSample(t - compensationMs / 1000, midi, pitchShiftSemis);
  }
  return accumulator.finalize();
}

const results = [];
for (let ms = 0; ms <= MAX_COMPENSATION_MS; ms += STEP_MS) {
  const r = scoreAt(ms);
  if (r !== null) results.push({ ms, ...r });
}

if (results.length === 0) {
  console.error("Nothing scoreable -- too few notes, or no overlap.");
  process.exit(1);
}

const argmax = results.reduce((a, b) => (b.overall > a.overall ? b : a));
const baseline = results[0];

// Never trust the raw argmax. Once the samples land inside the right notes,
// shifting further changes nothing until they start falling off the far edge,
// so the objective has a flat top; which sample in it happens to win is
// decided by coverage noise at the boundaries, and can sit at either end. The
// midpoint of the flat region is the stable estimate, and its width is the
// honest uncertainty on the answer.
const PLATEAU_TOLERANCE = 0.002;
const plateau = results.filter(
  (r) => argmax.overall - r.overall <= PLATEAU_TOLERANCE,
);
const plateauLo = plateau[0].ms;
const plateauHi = plateau[plateau.length - 1].ms;
const estimateMs = (plateauLo + plateauHi) / 2;
const best =
  results.reduce((a, b) =>
    Math.abs(b.ms - estimateMs) < Math.abs(a.ms - estimateMs) ? b : a,
  ) ?? argmax;

const peak = Math.max(...results.map((r) => r.overall));
console.log("  comp    overall  accuracy  coverage");
for (const r of results) {
  // Coarse rows keep the curve readable; the peak is always shown.
  if (r.ms % 10 !== 0 && r !== best) continue;
  const bar = "#".repeat(Math.round((r.overall / peak) * 40));
  const mark = r === best ? " <- best" : "";
  console.log(
    `  ${String(r.ms).padStart(5)}ms  ${(r.overall * 100).toFixed(1).padStart(5)}%   ` +
      `${(r.accuracy * 100).toFixed(1).padStart(5)}%    ${(r.coverage * 100).toFixed(1).padStart(5)}%  ${bar}${mark}`,
  );
}

console.log(
  `\nplateau:  ${plateauLo}-${plateauHi}ms (within ${PLATEAU_TOLERANCE * 100} points of peak)`,
);
console.log(
  `estimate: ${estimateMs}ms  -> ${(best.overall * 100).toFixed(1)}% (band ${best.band})`,
);
console.log(
  `argmax:   ${argmax.ms}ms (unstable on a flat top; shown for reference)`,
);
console.log(
  `at 0ms:   ${(baseline.overall * 100).toFixed(1)}% (band ${baseline.band})`,
);
console.log(
  `gain:     +${((best.overall - baseline.overall) * 100).toFixed(1)} points`,
);

if (plateauHi >= MAX_COMPENSATION_MS) {
  console.log(
    `\nWARNING: the plateau runs to the end of the sweep -- the true value may be higher than ${MAX_COMPENSATION_MS}ms.`,
  );
}
if (plateauHi - plateauLo > 60) {
  console.log(
    `\nNOTE: a ${plateauHi - plateauLo}ms plateau is wide. That happens when the take has few` +
      `\nnotes sung right up to their edges, so alignment is loosely constrained. The midpoint` +
      `\nis still the best estimate, but treat it as +/-${((plateauHi - plateauLo) / 2).toFixed(0)}ms.`,
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
