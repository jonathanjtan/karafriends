import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";

import { SongRange, songRangeFromScoringData } from "../common/vocalRange";

// Where a song sits, cached so it is computed once ever.
//
// Reading a range means having the song's reference melody, and the two
// catalogs differ enormously in what that costs:
//
//   * DAM ships an authored scoring blob: one minsei call, fast, and the
//     trustworthy reading because a human charted it.
//   * JOYSOUND has no chart. Ours is extracted from the guide-melody channel of
//     the song's ogg, which costs a fetch plus an ffmpeg decode plus a
//     pitch-track pass (~8s). Fine once per song somebody opens; out of the
//     question per row of a search list.
//
// So this cache is the thing that makes the feature usable: every song the room
// plays populates it for free at pop time, from scoringData already in hand, and
// list surfaces read it without touching the network.
export type SongRangeProvenance = "DAM_AUTHORED" | "JOYSOUND_EXTRACTED";

export interface SongRangeRecord extends SongRange {
  source: string;
  songId: string;
  provenance: SongRangeProvenance;
  timestamp: number;
}

const RANGES_PATH = path.join(app.getPath("userData"), "song-ranges.json");
const FILE_VERSION = 1;

// Keyed "SOURCE:songId", matching how merged-search node ids are qualified.
// The two catalogs hand out overlapping numeric ids, so an unqualified key
// would collide them.
let ranges = new Map<string, SongRangeRecord>();

function keyFor(source: string, songId: string): string {
  return `${source}:${songId}`;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Debounced, unlike scores and vocal ranges: this is a derived cache that costs
// a re-read to rebuild rather than a performance nobody can repeat, and pop-time
// population would otherwise write the whole file on every song.
function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(
        RANGES_PATH,
        JSON.stringify({
          version: FILE_VERSION,
          ranges: [...ranges.values()],
        }),
        "utf-8",
      );
    } catch (e) {
      console.error("[songRanges] failed to save", e);
    }
  }, 2000);
}

export function loadSongRanges(): void {
  try {
    if (!fs.existsSync(RANGES_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(RANGES_PATH, "utf-8"));
    ranges = new Map(
      (parsed?.ranges ?? [])
        .filter(
          (r: any) =>
            r && typeof r.songId === "string" && typeof r.lowMidi === "number",
        )
        .map((r: SongRangeRecord) => [keyFor(r.source, r.songId), r]),
    );
    console.log(`[songRanges] loaded ${ranges.size} song ranges`);
  } catch (e) {
    console.error("[songRanges] failed to load, starting empty", e);
    ranges = new Map();
  }
}

export function cachedSongRange(
  source: string,
  songId: string,
): SongRangeRecord | null {
  return ranges.get(keyFor(source, songId)) ?? null;
}

// Compute and cache from a scoring blob already in hand. Returns null when the
// blob carries no notes. Some JOYSOUND songs genuinely have no usable guide
// melody, and that is a real answer worth not recomputing.
export function rememberSongRange(
  source: string,
  songId: string,
  provenance: SongRangeProvenance,
  scoringData: readonly number[],
): SongRangeRecord | null {
  const range = songRangeFromScoringData(scoringData);
  if (range === null) return null;

  const record: SongRangeRecord = {
    ...range,
    source,
    songId,
    provenance,
    timestamp: Date.now(),
  };
  ranges.set(keyFor(source, songId), record);
  scheduleSave();
  return record;
}
