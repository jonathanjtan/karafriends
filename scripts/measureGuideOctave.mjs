#!/usr/bin/env node
// Measures the octave offset between an extracted JOYSOUND guide melody and
// where humans actually sang the same song.
//
// guideMelody.ts's own header says the JOYSOUND guide synth plays notes "an
// octave above notation" (F0_MAX_HZ is set to 1500 to accommodate it). If that
// is common rather than rare, then songRangeFromScoringData reads a range an
// octave above where anybody sings, and using it to match songs to a measured
// vocal range would be wrong in the most confusing possible way.
//
// Method: for each song with both a probe trace and a cached melody, compare
// the median sung pitch against the median reference pitch. A clean cluster
// near -12 is the guide sitting an octave high.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const PROBE_DIRS = [
  path.join(HOME, "Library/Application Support/karafriends/probe-logs"),
  path.join(HOME, "Library/Application Support/Electron/probe-logs"),
];
const MELODY_DIRS = [
  path.join(HOME, "Library/Application Support/Electron/melodies"),
  path.join(HOME, "Library/Application Support/karafriends/melodies"),
];

function compile() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_oct"));
  execFileSync(
    "corepack",
    [
      "yarn",
      "tsc",
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
const { parseScoringData } = await import(path.join(outDir, "scoringData.mjs"));

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// Collect sung pitches per songId from every probe log.
const sung = new Map();
for (const dir of PROBE_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".log")) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.startsWith("PROBE_PITCH ")) continue;
      const parts = line.split(/\s+/);
      // PROBE_PITCH <songId> <time> <midi> <shift>
      const songId = parts[1];
      const midi = parseFloat(parts[3]);
      if (!Number.isFinite(midi) || midi <= 0) continue;
      if (!sung.has(songId)) sung.set(songId, []);
      sung.get(songId).push(midi);
    }
  }
}

function findMelody(songId) {
  for (const dir of MELODY_DIRS) {
    const p = path.join(dir, `joysound-${songId}-melody.bin`);
    if (fs.existsSync(p)) return Array.from(fs.readFileSync(p));
  }
  return null;
}

console.log(`songs with probe traces: ${sung.size}\n`);
console.log("songId    sungMed  refMed   diff   nearestOctave  notes  samples");

const diffs = [];
for (const [songId, pitches] of [...sung.entries()].sort()) {
  if (pitches.length < 500) continue;
  const data = findMelody(songId);
  if (!data) continue;
  const { notes } = parseScoringData(data);
  if (notes.length < 24) continue;

  // Duration-weighted reference median, matching songRangeFromScoringData.
  const weighted = [];
  for (const n of notes) {
    const frames = Math.max(1, Math.round((n.endTime - n.startTime) * 50));
    for (let i = 0; i < frames; i++) weighted.push(n.midiNumber);
  }
  const refMed = median(weighted);
  const sungMed = median(pitches);
  const diff = sungMed - refMed;
  const nearest = Math.round(diff / 12) * 12;
  diffs.push({ songId, diff, nearest });
  console.log(
    `${songId.padEnd(9)} ${sungMed.toFixed(1).padStart(7)} ${String(refMed).padStart(7)} ` +
      `${diff.toFixed(1).padStart(6)} ${String(nearest).padStart(14)} ` +
      `${String(notes.length).padStart(6)} ${String(pitches.length).padStart(8)}`,
  );
}

if (diffs.length === 0) {
  console.log("\n(no song had both a probe trace and a cached melody)");
} else {
  const buckets = new Map();
  for (const d of diffs)
    buckets.set(d.nearest, (buckets.get(d.nearest) ?? 0) + 1);
  console.log("\nnearest-octave histogram of (sung - reference):");
  for (const [k, v] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(
      `  ${String(k).padStart(4)} semitones: ${"#".repeat(v)} (${v})`,
    );
  }
  const residuals = diffs.map((d) => d.diff - d.nearest);
  console.log(
    `\nresidual after removing the octave: median ${median(residuals).toFixed(2)} semitones`,
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
