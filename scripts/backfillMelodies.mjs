#!/usr/bin/env node
// Rebuilds the guide-melody cache for songs you have recorded performances of.
//
// The sung takes in <userData>/probe-logs/ are useless for offline scoring work
// without the melody each one was sung against, and melodies used to live only
// in the temp dir, which macOS sweeps by age (~3 days untouched) rather than
// only on reboot. That is how the original 29-take corpus was lost. Melodies
// are mirrored to <userData>/melodies/ now, but anything extracted before that
// has to be re-fetched, which needs the song's audio, not another
// performance. Nobody has to sing again.
//
// Drives the running app rather than reimplementing anything: the
// backfillGuideMelody mutation fetches the song's audio through the app's own
// JOYSOUND session and proxy and runs the real extraction, so there is no
// duplicated login flow here and no second copy of the pipeline to drift.
//
//   corepack yarn run-dev            # in another terminal, app must be running
//   node scripts/backfillMelodies.mjs
//
// By default it takes every JOYSOUND songId that appears in the probe logs and
// skips the ones already cached. --songs backfills an explicit list instead.
//
//   node scripts/backfillMelodies.mjs --songs 15410,31783
//   node scripts/backfillMelodies.mjs --port 8099 --dry-run
//
// Songs are done one at a time on purpose: each is a getFME fetch plus an
// ffmpeg decode and a pitch-track pass, and there is no reason to hammer
// JOYSOUND to save a few minutes on a job you run once.

import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_PORT = 8080;
// A getFME fetch plus extraction on a long song; generous because the retry
// inside the app can take a while on a flaky connection.
const REQUEST_TIMEOUT_MS = 180_000;

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    `usage:
  node scripts/backfillMelodies.mjs [--songs <id,id,...>] [--port <port>]
                                    [--logs <dir|file>] [--dry-run]

  --songs    Backfill these songIds instead of the ones found in probe logs.
  --port     Where the app is listening (default ${DEFAULT_PORT}).
  --logs     Probe log dir or file (default <userData>/probe-logs).
  --dry-run  List what would be fetched and stop.`,
  );
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) usage(`Unexpected argument ${flag}.`);
    if (flag === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) usage(`${flag} needs a value.`);
    out[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

// The packaged app and `run-dev` keep separate userData dirs, the dev one
// named after the Electron executable, so anything written there lands in a
// different place depending on which build produced it. Both are searched; the
// packaged one comes first because that is where real parties write.
function userDataDirs() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library/Application Support");
    return [path.join(base, "karafriends"), path.join(base, "Electron")];
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData/Roaming");
    return [path.join(base, "karafriends"), path.join(base, "Electron")];
  }
  return [
    path.join(home, ".config/karafriends"),
    path.join(home, ".config/Electron"),
  ];
}

const userDataDir = () => userDataDirs()[0];

// Both places a melody can already be: the durable mirror and the temp cache.
function melodyDirs() {
  return [
    ...userDataDirs().map((dir) => path.join(dir, "melodies")),
    path.join(fs.realpathSync(os.tmpdir()), "karafriends_tmp"),
  ];
}

const isCached = (songId) =>
  melodyDirs().some((dir) =>
    fs.existsSync(path.join(dir, `joysound-${songId}-melody.bin`)),
  );

// songIds in the order they were first sung, so a partial run covers the
// oldest takes first. Those are the ones whose melodies have expired.
function songIdsFromLogs(logTarget) {
  const files = fs.statSync(logTarget).isDirectory()
    ? fs
        .readdirSync(logTarget)
        .filter((f) => f.endsWith(".log"))
        .sort()
        .map((f) => path.join(logTarget, f))
    : [logTarget];

  const ids = [];
  const seen = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/PROBE_PITCH ([\w-]+) /);
      if (!m) continue;
      const songId = m[1];
      // DAM ids look like "3747-03" and carry their own scoring blob from the
      // service; only JOYSOUND songs have a melody we extract and cache.
      if (!/^\d+$/.test(songId) || seen.has(songId)) continue;
      seen.add(songId);
      ids.push(songId);
    }
  }
  return ids;
}

async function backfill(port, songId) {
  const response = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `mutation ($songId: String!) {
        backfillGuideMelody(songId: $songId) {
          songId
          noteCount
          alreadyCached
        }
      }`,
      variables: { songId },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data.backfillGuideMelody;
}

const args = parseArgs();
const port = args.port ? Number(args.port) : DEFAULT_PORT;
const logTarget = args.logs || path.join(userDataDir(), "probe-logs");

let candidates;
if (args.songs) {
  candidates = args.songs
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
} else {
  if (!fs.existsSync(logTarget)) {
    console.error(
      `No probe logs at ${logTarget}. Pass --songs to backfill an explicit list, or --logs to point elsewhere.`,
    );
    process.exit(1);
  }
  candidates = songIdsFromLogs(logTarget);
}

const missing = candidates.filter((songId) => !isCached(songId));
console.log(
  `${candidates.length} song${candidates.length === 1 ? "" : "s"} to consider, ${
    candidates.length - missing.length
  } already cached, ${missing.length} to fetch.`,
);

if (missing.length === 0) process.exit(0);
if (args.dryRun) {
  console.log(missing.join("\n"));
  process.exit(0);
}

// Fail fast and clearly if the app isn't up: every song would otherwise report
// the same connection error in turn.
try {
  await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ __typename }" }),
    signal: AbortSignal.timeout(5000),
  });
} catch {
  console.error(
    `Nothing answering on http://localhost:${port}/graphql. Start the app (corepack yarn run-dev) and try again, or pass --port.`,
  );
  process.exit(1);
}

let extracted = 0;
let empty = 0;
const failures = [];

for (const [index, songId] of missing.entries()) {
  const progress = `[${index + 1}/${missing.length}] ${songId}`;
  try {
    const result = await backfill(port, songId);
    if (result.noteCount > 0) {
      extracted++;
      console.log(`${progress}: ${result.noteCount} notes`);
    } else {
      // Cached as empty by design, so it isn't retried forever.
      empty++;
      console.log(`${progress}: no usable guide melody`);
    }
  } catch (error) {
    failures.push(songId);
    console.error(`${progress}: ${error.message}`);
  }
}

console.log(
  `\nDone. ${extracted} extracted, ${empty} without a usable melody, ${failures.length} failed.`,
);
if (failures.length > 0) {
  console.log(`Retry with: --songs ${failures.join(",")}`);
  process.exit(1);
}
