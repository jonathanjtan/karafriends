import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";

// A scored performance, kept so a singer can be shown their own history.
//
// Until now a score existed only as the PNG screenshot the renderer saves,
// which nobody can query. These records are what a personal best, a "previous
// take", or any later per-song view read from.
export interface ScoreRecord {
  // Whose take it was. personId is the real identity and survives a new device
  // or a cleared localStorage; it is absent on pre-registry clients, which is
  // why the nickname is stored beside it rather than looked up.
  personId: string | null;
  nickname: string;
  // Which song, in the same shape songHistory uses.
  songType: string;
  songId: string;
  songName: string;
  artistName: string | null;
  timestamp: number;
  // The number that was shown, and the raw composite behind it.
  display: number;
  band: string;
  overall: number;
  // The axes, null where the song could not be judged on one.
  pitch: number;
  longTone: number | null;
  timing: number | null;
  // What the take was actually scored at, so a night's records can be used to
  // re-derive the machine's mic latency (see docs/scoring-tuning-handoff.md).
  compensationMs: number;
  // The formula that produced `display`. A record from an older version is not
  // on the same scale as a new one; keeping the version is what lets a caller
  // notice rather than silently compare them.
  formulaVersion: number;
}

// userData, not the temp dir: the whole point of a personal best is surviving,
// and an OS temp sweep would wipe it. Same reasoning as people.json and the
// song-history mirror, and the melody cache learned this the hard way.
const SCORES_PATH = path.join(app.getPath("userData"), "scores.json");
const FILE_VERSION = 1;
// A night is tens of records and each is small, but nothing prunes this file,
// so cap it rather than letting a year of parties turn into a slow read. The
// oldest go first; a personal best older than this many songs is not what
// anybody is arguing about.
const MAX_RECORDS = 5000;

let scores: ScoreRecord[] = [];

function writeScoresToDisk(): void {
  try {
    fs.writeFileSync(
      SCORES_PATH,
      JSON.stringify({ version: FILE_VERSION, scores }),
      "utf-8",
    );
  } catch (e) {
    console.error("[scores] failed to save", e);
  }
}

function isScoreRecord(value: any): value is ScoreRecord {
  return (
    value &&
    typeof value.songId === "string" &&
    typeof value.display === "number" &&
    typeof value.timestamp === "number"
  );
}

export function loadScores(): void {
  try {
    if (!fs.existsSync(SCORES_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(SCORES_PATH, "utf-8"));
    scores = (parsed?.scores ?? []).filter(isScoreRecord);
    console.log(`[scores] loaded ${scores.length} scores`);
  } catch (e) {
    console.error("[scores] failed to load, starting empty", e);
    scores = [];
  }
}

// Written synchronously: a score is produced once, at the end of a song, and
// losing the best take of the night to a crash before a debounce fired would be
// exactly the record anyone cared about.
export function recordScore(record: ScoreRecord): void {
  scores.push(record);
  if (scores.length > MAX_RECORDS) {
    scores = scores.slice(scores.length - MAX_RECORDS);
  }
  writeScoresToDisk();
}

// Does this record belong to the singer being asked about? personId when both
// sides have one, nickname otherwise, the same rule songPlayCount uses, so
// the card's "3rd time" and its "your best" can't disagree about who sang.
function isSameSinger(
  record: ScoreRecord,
  personId: string | null,
  nickname: string,
): boolean {
  if (personId && record.personId) return record.personId === personId;
  return record.nickname === nickname;
}

export interface ScoreHistory {
  // Highest display score this singer has had on this song, and when.
  best: ScoreRecord | null;
  // Their most recent take on it, which is not usually the same record.
  previous: ScoreRecord | null;
  // How many of their takes on it are stored.
  count: number;
}

// This singer's history on one song, newest formula only.
//
// Records from an older formulaVersion are excluded rather than shown: they
// were produced on a different scale, and a "personal best" nobody can beat
// because the curve moved is worse than no personal best at all.
export function scoreHistoryFor(
  songType: string,
  songId: string,
  nickname: string,
  personId: string | null,
  formulaVersion: number,
): ScoreHistory {
  const mine = scores.filter(
    (record) =>
      record.songType === songType &&
      record.songId === songId &&
      record.formulaVersion === formulaVersion &&
      isSameSinger(record, personId, nickname),
  );
  if (mine.length === 0) return { best: null, previous: null, count: 0 };

  const best = mine.reduce((a, b) => (b.display > a.display ? b : a));
  const previous = mine.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  return { best, previous, count: mine.length };
}

export function listScores(): ScoreRecord[] {
  return scores;
}
