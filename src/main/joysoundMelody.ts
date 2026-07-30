import { spawn } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";

import {
  buildScoringData,
  extractGuideMelodyNotes,
} from "../common/guideMelody";
import { resourcePaths, TEMP_FOLDER } from "../common/videoDownloader";

// Guide-melody extraction results, keyed by songId. Extraction kicks off at
// download time (fire-and-forget) so the data is ready by the time the song
// is popped for playback; results are cached on disk next to the composited
// video so app restarts don't recompute.
const inFlightExtractions: Map<string, Promise<Uint8Array | null>> = new Map();

function melodyCacheFilename(songId: string): string {
  return `${TEMP_FOLDER}/joysound-${songId}-melody.bin`;
}

// A durable copy beside config.yaml, because the temp dir is not a cache we
// control: macOS sweeps /var/folders by *age* (about three days untouched),
// not only on reboot, so a melody extracted last week is simply gone. Same
// reasoning as song-history.json and the people registry.
//
// The composited videos in the temp dir are a genuine cache -- they re-download
// -- but a melody is the one thing offline scoring work cannot reconstruct
// without re-fetching the song, and it is a few KB of deterministic output per
// song. scripts/replayScoring.mjs reads this directory too.
const MELODY_MIRROR_DIR = path.join(app.getPath("userData"), "melodies");

function melodyMirrorFilename(songId: string): string {
  return path.join(MELODY_MIRROR_DIR, `joysound-${songId}-melody.bin`);
}

// Write both copies. The temp one stays the primary read path (it sits beside
// the composited video, and everything else in the pipeline already looks
// there); the mirror is what survives the sweep.
function writeMelodyCache(songId: string, scoringData: Uint8Array): void {
  try {
    fs.writeFileSync(melodyCacheFilename(songId), scoringData);
  } catch (e) {
    console.error(`Failed writing guide melody cache for ${songId}`, e);
  }
  try {
    fs.mkdirSync(MELODY_MIRROR_DIR, { recursive: true });
    fs.writeFileSync(melodyMirrorFilename(songId), scoringData);
  } catch (e) {
    console.error(`Failed writing guide melody mirror for ${songId}`, e);
  }
}

// The cached melody from wherever it survived. A mirror hit is restored into
// the temp dir on the way past, so the next read is local again and the file
// sits beside its video as the rest of the pipeline expects.
function readMelodyCache(songId: string): Uint8Array | null {
  try {
    return fs.readFileSync(melodyCacheFilename(songId));
  } catch {
    // Not in temp; fall through to the mirror.
  }
  try {
    const mirrored = fs.readFileSync(melodyMirrorFilename(songId));
    try {
      fs.writeFileSync(melodyCacheFilename(songId), mirrored);
    } catch (e) {
      console.error(`Failed restoring guide melody for ${songId}`, e);
    }
    return mirrored;
  } catch {
    return null;
  }
}

// Decodes the guide melody (FC) channel of a media file or in-memory ogg
// buffer to s16le mono 16kHz PCM. For stereo inputs (no guide melody
// channel), pan resolves FC to silence and the extraction below rejects it.
function decodeGuideMelodyChannel(source: {
  oggBuffer?: Buffer;
  mediaFilename?: string;
}): Promise<Int16Array | null> {
  return new Promise((resolve) => {
    const ffmpeg = spawn(resourcePaths.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source.mediaFilename ? source.mediaFilename : "-",
      "-map",
      "0:a:0",
      "-filter:a",
      "pan=mono|c0=FC",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "-",
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.on("error", (error) => {
      console.error("Guide melody ffmpeg spawn failed", error);
      resolve(null);
    });
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error(`Guide melody ffmpeg exited with code ${code}`);
        resolve(null);
        return;
      }
      const pcmBuffer = Buffer.concat(chunks);
      resolve(
        new Int16Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          Math.floor(pcmBuffer.byteLength / 2),
        ),
      );
    });

    if (source.oggBuffer) {
      ffmpeg.stdin.on("error", () => {
        // EPIPE if ffmpeg dies early; the "close" handler deals with it.
      });
      ffmpeg.stdin.write(source.oggBuffer);
      ffmpeg.stdin.end();
    } else {
      ffmpeg.stdin.end();
    }
  });
}

async function extractAndCache(
  songId: string,
  source: { oggBuffer?: Buffer; mediaFilename?: string },
): Promise<Uint8Array | null> {
  const pcm = await decodeGuideMelodyChannel(source);
  if (pcm === null) return null;

  const notes = await extractGuideMelodyNotes(pcm);
  const scoringData = buildScoringData(notes);

  // Cached even when empty (header with zero notes) so songs without a
  // usable guide melody aren't re-analyzed on every replay.
  writeMelodyCache(songId, scoringData);
  console.info(`Guide melody extraction for ${songId}: ${notes.length} notes`);
  return scoringData;
}

// Whether a melody has actually been extracted and cached for this song.
//
// Distinct from getJoysoundScoringData returning null, which also covers "the
// extraction ran and found no usable melody channel" -- that result is cached
// deliberately so it isn't retried forever. A caller that needs to tell a
// finished-but-empty extraction from one that never ran (ffmpeg missing, the
// fetch failing) has to ask about the file.
export function hasCachedGuideMelody(songId: string): boolean {
  return readMelodyCache(songId) !== null;
}

// Kicks off (or reuses) guide-melody extraction for a song. Callers pass the
// raw ogg when they have it (initial download) or the composited video file
// (whose audio stream is the ogg, copied) when reusing a cached download.
export function ensureJoysoundGuideMelody(
  songId: string,
  source: { oggBuffer?: Buffer; mediaFilename?: string },
): void {
  if (inFlightExtractions.has(songId)) return;
  // readMelodyCache rather than an existsSync on the temp path: after a sweep
  // the mirror still has it, and re-extracting a melody we already own would
  // cost an ffmpeg decode and a pitch-track pass for nothing.
  if (readMelodyCache(songId) !== null) return;

  inFlightExtractions.set(
    songId,
    extractAndCache(songId, source)
      .catch((e) => {
        console.error(`Guide melody extraction failed for ${songId}`, e);
        return null;
      })
      .finally(() => {
        // Leave completed extractions to the disk cache; keeping the map
        // entry only while in flight avoids holding buffers alive.
        setTimeout(() => inFlightExtractions.delete(songId), 0);
      }) as Promise<Uint8Array | null>,
  );
}

// Resolver entry point: returns the scoring-data byte array for a song, or
// null when no guide melody is available (not downloaded yet, extraction
// failed, or the song has no usable melody channel).
export async function getJoysoundScoringData(
  songId: string,
): Promise<number[] | null> {
  let scoringData: Uint8Array | null = null;

  const inFlight = inFlightExtractions.get(songId);
  if (inFlight) {
    scoringData = await inFlight;
  } else {
    scoringData = readMelodyCache(songId);
    if (scoringData === null) return null;
  }

  if (scoringData === null || scoringData.length < 24) return null;
  const noteCount = new DataView(
    scoringData.buffer,
    scoringData.byteOffset,
    scoringData.byteLength,
  ).getUint32(4, true);
  if (noteCount === 0) return null;

  return Array.from(scoringData);
}
