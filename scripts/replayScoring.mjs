#!/usr/bin/env node
// Replays recorded performances through the real ScoreAccumulator and dumps the
// exact ScoreResult for each, so a scoring change can be compared against a
// corpus of real singing instead of one take and a hunch.
//
// This is the tool the offline half of the scoring work runs on (see
// docs/scoring-scorecard-proposal.md). Two uses:
//
//   1. Regression. Snapshot before a change, snapshot after, diff:
//        node scripts/replayScoring.mjs --out before.json
//        ...edit src/common/scoring.ts...
//        node scripts/replayScoring.mjs --out after.json
//        node scripts/replayScoring.mjs --diff before.json after.json
//      A refactor that shouldn't move any number can be proven not to.
//
//   2. Tuning. `--out -` prints a table instead, which is how you see whether a
//      formula change lands the bands where you meant it to across every take
//      rather than just the one you were listening to.
//
// Inputs are what the app already leaves lying around:
//   * PROBE_PITCH logs from `pitchProbeEnabled` --
//     <userData>/probe-logs/probe-<date>.log (see the handoff doc for how to
//     capture them; each line carries its songId, so one log holds a session).
//   * the cached guide melody per song -- <userData>/melodies/ first, then
//     <temp>/karafriends_tmp/, both named joysound-<songId>-melody.bin. The
//     temp copy expires (macOS sweeps /var/folders by age, which is what took
//     the original 29-take corpus out); the userData mirror is the durable one.
// Both default to those locations; --logs and --melody-dir override.
//
// The compensation defaults to 105ms (config's 80 plus the ~25ms live output
// term on the dev machine) so replayed numbers match what the app scored at
// capture time. Pass --compensation to sweep it.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// What the app applied when these logs were captured: micLatencyCalibrationMs
// plus AudioContext.outputLatency. Not read from config on purpose -- a replay
// has to be reproducible across machines.
const DEFAULT_COMPENSATION_MS = 105;

// Below these a take isn't worth scoring: too little reference melody to judge
// against (isScoreable's own floor), or the singer barely opened their mouth.
const MIN_NOTES = 24;
const MIN_SAMPLES = 1500;

function usage(msg) {
  if (msg) console.error(`${msg}\n`);
  console.error(
    `usage:
  node scripts/replayScoring.mjs [--out <file|->] [--logs <dir|file>]
                                 [--melody-dir <dir>] [--compensation <ms>]
                                 [--song <songId>]
  node scripts/replayScoring.mjs --diff <before.json> <after.json>`,
  );
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { diff: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--diff") {
      out.diff = [argv[i + 1], argv[i + 2]];
      if (!out.diff[0] || !out.diff[1]) usage("--diff needs two files.");
      return out;
    }
    if (!flag.startsWith("--")) usage(`Unexpected argument ${flag}.`);
    const value = argv[++i];
    if (value === undefined) usage(`${flag} needs a value.`);
    out[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

// Compile the real scoring code rather than reimplementing it: a
// reimplementation drifts, and then the replay is measuring the wrong thing.
// Same approach as scripts/measureMicLatency.mjs.
function compileScoring() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_replay"));
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

function defaultLogDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library/Application Support/karafriends/probe-logs",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData/Roaming"),
      "karafriends/probe-logs",
    );
  }
  return path.join(home, ".config/karafriends/probe-logs");
}

// Searched in order, so an expired temp copy falls through to the mirror.
function defaultMelodyDirs() {
  // The packaged app and `run-dev` keep separate userData dirs (the dev one is
  // named after the Electron executable), so a melody extracted under run-dev
  // does not land beside the probe logs a packaged party wrote. Search both.
  const userData = path.dirname(defaultLogDir());
  const devUserData = path.join(path.dirname(userData), "Electron");
  return [
    path.join(userData, "melodies"),
    path.join(devUserData, "melodies"),
    path.join(fs.realpathSync(os.tmpdir()), "karafriends_tmp"),
  ];
}

function findMelody(dirs, songId) {
  for (const dir of dirs) {
    const candidate = path.join(dir, `joysound-${songId}-melody.bin`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Every PROBE_PITCH line across every log, keyed "<log stem>/<songId>" so the
// same song sung twice on different nights stays two takes. Both the tagged
// and the older untagged line formats are accepted; untagged lines can't be
// attributed to a song, so they're skipped rather than guessed at.
function readTakes(logTarget) {
  const files = fs.statSync(logTarget).isDirectory()
    ? fs
        .readdirSync(logTarget)
        .filter((f) => f.endsWith(".log"))
        .map((f) => path.join(logTarget, f))
    : [logTarget];

  const takes = new Map();
  for (const file of files) {
    const stem = path.basename(file).replace(/\.log$/, "");
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(
        /PROBE_PITCH ([\w-]+) (-?[\d.]+) (-?[\d.]+) (-?\d+)/,
      );
      if (!m) continue;
      const [, songId, t, midi, shift] = m;
      const key = `${stem}/${songId}`;
      let take = takes.get(key);
      if (take === undefined) {
        take = { songId, samples: [] };
        takes.set(key, take);
      }
      take.samples.push({
        t: parseFloat(t),
        midi: parseFloat(midi),
        shift: parseInt(shift, 10),
      });
    }
  }
  for (const take of takes.values()) take.samples.sort((a, b) => a.t - b.t);
  return takes;
}

// songId -> display name, so a table is readable. Best-effort: the mirror only
// covers what the app has actually played.
function readSongNames() {
  const dir = path.dirname(defaultLogDir());
  const names = new Map();
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "song-history.json"), "utf8"),
    );
    const items = Array.isArray(raw)
      ? raw
      : raw.songHistory || Object.values(raw)[0] || [];
    for (const item of items) {
      const song = item.song || item;
      if (song && song.songId) names.set(String(song.songId), song.name);
    }
  } catch {
    // No mirror yet, or an unreadable one. Names are cosmetic.
  }
  return names;
}

function diff(beforePath, afterPath) {
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort();
  let changed = 0;
  for (const key of keys) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(after[key]);
    if (a === b) continue;
    changed++;
    console.log(`DIFF ${key}\n  before ${a}\n  after  ${b}`);
  }
  console.log(
    changed === 0
      ? `IDENTICAL across ${keys.length} takes`
      : `${changed} of ${keys.length} takes differ`,
  );
  // Non-zero on any change, so this can gate a refactor that must not move a
  // number. A deliberate formula change is expected to "fail" here.
  process.exit(changed === 0 ? 0 : 1);
}

const args = parseArgs();
if (args.diff) diff(args.diff[0], args.diff[1]);

const logTarget = args.logs || defaultLogDir();
const melodyDirs = args.melodyDir ? [args.melodyDir] : defaultMelodyDirs();
const compensationMs =
  args.compensation === undefined
    ? DEFAULT_COMPENSATION_MS
    : parseFloat(args.compensation);

if (!fs.existsSync(logTarget)) {
  console.error(
    `No probe logs at ${logTarget}. Capture a take with pitchProbeEnabled first (see docs/scoring-tuning-handoff.md), or pass --logs.`,
  );
  process.exit(1);
}
if (!melodyDirs.some((dir) => fs.existsSync(dir))) {
  console.error(
    `No melody cache in any of:\n  ${melodyDirs.join("\n  ")}\nMelodies are written when a JOYSOUND song downloads; the userData copy is the durable one. Pass --melody-dir to point elsewhere.`,
  );
  process.exit(1);
}

const outDir = compileScoring();
const { ScoreAccumulator, isScoreable } = await import(
  path.join(outDir, "scoring.js")
);
const { parseScoringData } = await import(path.join(outDir, "scoringData.js"));

const names = readSongNames();
const takes = readTakes(logTarget);
const results = {};
const rows = [];
const skipped = [];

for (const [key, take] of [...takes.entries()].sort()) {
  if (args.song !== undefined && take.songId !== args.song) continue;

  const melodyPath = findMelody(melodyDirs, take.songId);
  if (melodyPath === null) {
    skipped.push(`${key}: no cached melody`);
    continue;
  }
  if (take.samples.length < MIN_SAMPLES) {
    skipped.push(`${key}: only ${take.samples.length} samples`);
    continue;
  }

  const { notes, lyricsIntervals } = parseScoringData([
    ...fs.readFileSync(melodyPath),
  ]);
  if (notes.length < MIN_NOTES || !isScoreable(notes)) {
    skipped.push(`${key}: ${notes.length} reference notes`);
    continue;
  }

  const accumulator = new ScoreAccumulator(
    notes,
    lyricsIntervals,
    compensationMs,
  );
  for (const s of take.samples) {
    accumulator.addSample(s.t, s.midi, s.shift);
  }
  const result = accumulator.finalize();
  if (result === null) {
    skipped.push(`${key}: not scoreable`);
    continue;
  }

  // Rounded so a diff reports real behaviour changes rather than float noise
  // from a reordered summation.
  const round = (n) => +n.toFixed(9);
  results[key] = {
    name: names.get(take.songId) || take.songId,
    display: round(result.display),
    overall: round(result.overall),
    band: result.band,
    pitch: round(result.pitch),
    longTone: result.longTone === null ? null : round(result.longTone),
    timing: result.timing === null ? null : round(result.timing),
    coverage: round(result.coverage),
    notesAttempted: result.notesAttempted,
    notesTotal: result.notesTotal,
    compensationMs: result.compensationMs,
    buckets: result.buckets.map((b) => (b === null ? null : round(b))),
  };
  rows.push({ key, ...results[key], samples: accumulator.samples().length });
}

fs.rmSync(outDir, { recursive: true, force: true });

if (rows.length === 0) {
  console.error(
    `Nothing to score. Skipped ${skipped.length}:\n  ${skipped.join("\n  ")}`,
  );
  process.exit(1);
}

if (args.out && args.out !== "-") {
  fs.writeFileSync(args.out, JSON.stringify(results, null, 1));
  console.log(`Wrote ${rows.length} takes to ${args.out}`);
} else {
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const num = (n, w, d = 1) => n.toFixed(d).padStart(w);
  console.log(
    `${pad("take", 22)} ${pad("song", 24)} ${"score".padStart(6)} ${"band".padStart(4)} ${"pitch".padStart(6)} ${"long".padStart(6)} ${"time".padStart(6)} ${"cover".padStart(6)} ${"fit".padStart(5)}`,
  );
  for (const r of rows.sort((a, b) => a.display - b.display)) {
    console.log(
      `${pad(r.key, 22)} ${pad(r.name, 24)} ${num(r.display, 6)} ${r.band.padStart(4)} ${num(r.pitch * 100, 6)} ${r.longTone === null ? "     -" : num(r.longTone * 100, 6)} ${r.timing === null ? "     -" : num(r.timing * 100, 6)} ${num(r.coverage * 100, 6)} ${num(r.compensationMs, 5, 0)}`,
    );
  }
  const bands = {};
  for (const r of rows) bands[r.band] = (bands[r.band] || 0) + 1;
  const overalls = rows.map((r) => r.display).sort((a, b) => a - b);
  const fits = rows.map((r) => r.compensationMs).sort((a, b) => a - b);
  console.log(
    `\nn=${rows.length} seeded ${compensationMs}ms, fitted ${fits[0]}-${fits[fits.length - 1]} (median ${fits[Math.floor(fits.length / 2)]}) · ${overalls[0].toFixed(1)}-${overalls[overalls.length - 1].toFixed(1)} · mean ${(overalls.reduce((a, b) => a + b, 0) / overalls.length).toFixed(1)} · ${Object.entries(
      bands,
    )
      .map(([b, c]) => `${b}:${c}`)
      .join(" ")}`,
  );
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length}:\n  ${skipped.join("\n  ")}`);
}
