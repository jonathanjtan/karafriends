import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";

// A singer's measured range from the guided warm-up.
//
// Deliberately a log rather than one row per person: a voice on a Tuesday and a
// voice at 1am after four songs are different instruments, and keeping the
// history means a later "your range has been drifting" reading is possible
// without re-instrumenting anything. Readers take the newest.
export interface VocalRangeRecord {
  // Whose it is. personId is the real identity and survives a new device or a
  // cleared localStorage; nickname is stored beside it because pre-registry
  // clients have no personId. Same rule as ScoreRecord.
  personId: string | null;
  nickname: string;
  timestamp: number;
  // Every bound is nullable: an exercise nobody sang into produces no reading,
  // and recording that honestly beats recording a range of zero.
  lowMidi: number | null;
  highMidi: number | null;
  comfortableLowMidi: number | null;
  comfortableHighMidi: number | null;
  // The singer reached the lowest/highest tone offered, so the exercise ran out
  // before their voice did. Consumers offer a re-run centred further out rather
  // than treating this as a limit.
  hitFloor: boolean;
  hitCeiling: boolean;
  // Which estimator produced this (VOCAL_RANGE_VERSION). A record from an older
  // version is not on the same scale; keeping it lets a caller notice rather
  // than silently mixing them.
  version: number;
}

// userData, not the temp dir: an OS temp sweep would wipe it, and re-measuring
// means asking somebody to sing a warm-up again. Same reasoning as scores.json,
// people.json and the song-history mirror.
const RANGES_PATH = path.join(app.getPath("userData"), "vocal-ranges.json");
const FILE_VERSION = 1;
// One record per warm-up, and warm-ups are rare next to songs, so this cap is
// generous. It exists so a year of parties can't turn the file into a slow read.
const MAX_RECORDS = 2000;

let ranges: VocalRangeRecord[] = [];

function writeRangesToDisk(): void {
  try {
    fs.writeFileSync(
      RANGES_PATH,
      JSON.stringify({ version: FILE_VERSION, ranges }),
      "utf-8",
    );
  } catch (e) {
    console.error("[vocalRanges] failed to save", e);
  }
}

function isVocalRangeRecord(value: any): value is VocalRangeRecord {
  return (
    value &&
    typeof value.nickname === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.version === "number"
  );
}

export function loadVocalRanges(): void {
  try {
    if (!fs.existsSync(RANGES_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(RANGES_PATH, "utf-8"));
    ranges = (parsed?.ranges ?? []).filter(isVocalRangeRecord);
    console.log(`[vocalRanges] loaded ${ranges.length} ranges`);
  } catch (e) {
    console.error("[vocalRanges] failed to load, starting empty", e);
    ranges = [];
  }
}

// Written synchronously, for the same reason recordScore is: a range is
// produced once, at the end of an exercise somebody actually sang, and losing it
// to a crash before a debounce fired would mean asking them to do it again.
export function recordVocalRange(record: VocalRangeRecord): void {
  ranges.push(record);
  if (ranges.length > MAX_RECORDS) {
    ranges = ranges.slice(ranges.length - MAX_RECORDS);
  }
  writeRangesToDisk();
}

// personId when both sides have one, nickname otherwise, the same rule
// scoreHistoryFor and songPlayCount use, so the profile page and the song page
// can't disagree about whose range they are showing.
function isSameSinger(
  record: VocalRangeRecord,
  personId: string | null,
  nickname: string,
): boolean {
  if (personId && record.personId) return record.personId === personId;
  return record.nickname === nickname;
}

// This singer's most recent measurement at the current estimator version, or
// null. Older versions are excluded rather than shown: they were produced on a
// different scale, and a stale band would quietly mis-target every song
// suggestion built on top of it.
export function latestVocalRangeFor(
  nickname: string,
  personId: string | null,
  version: number,
): VocalRangeRecord | null {
  const mine = ranges.filter(
    (record) =>
      record.version === version && isSameSinger(record, personId, nickname),
  );
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
}

export function listVocalRanges(): VocalRangeRecord[] {
  return ranges;
}
