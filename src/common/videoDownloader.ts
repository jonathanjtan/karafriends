import { spawn } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import path from "path";
import process from "process";

import invariant from "ts-invariant";

import karafriendsConfig from "./config";

import {
  DownloadQueueItem,
  JoysoundQueueItem,
  QueueSongResult,
  UserIdentity,
} from "../main/graphql";
import { JoysoundAPI, JoysoundSongRawData } from "../main/joysoundApi";
import {
  ensureJoysoundGuideMelody,
  getJoysoundScoringData,
} from "../main/joysoundMelody";

import { GuideMelodyNote, parseScoringData } from "./guideMelody";

import { decodeJoysoundBase64Field, getSongDuration } from "./joysoundParser";

export const TEMP_FOLDER: string = `${app.getPath("temp")}/karafriends_tmp`;
const captionCodeRe: RegExp = new RegExp(/^[a-z]{2}$/);

export const extraResourcesPath: string =
  process.env.NODE_ENV === "development"
    ? `${app.getAppPath()}/../../../extraResources/`
    : `${process.resourcesPath}/extraResources/`;

interface ResourcePaths {
  // Path to the directory containing the ffmpeg executable
  ffmpeg: string;
  // Path to the ytdlp executable
  ytdlp: string;
}

interface JoysoundVideoData {
  songId: string;
  songDuration: number;
  songPlaytime: number;
  videoPlaytime: number;
  oggBuffer: Buffer;
}

const linuxResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/linux/ffmpeg`,
  ytdlp: `${extraResourcesPath}/ytdlp/yt-dlp`,
};

const macosResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/macos/ffmpeg`,
  ytdlp: `${extraResourcesPath}ytdlp/yt-dlp_macos`,
};

const winResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/win/ffmpeg.exe`,
  ytdlp: `${extraResourcesPath}ytdlp/yt-dlp.exe`,
};

export const resourcePaths: ResourcePaths =
  process.platform === "win32"
    ? winResourcePaths
    : process.platform === "darwin"
      ? macosResourcePaths
      : linuxResourcePaths;

// Extra yt-dlp args pointing at a Netscape-format cookies.txt with
// youtube.com cookies, letting yt-dlp download age-restricted or
// bot-checked videos. Uses config.yaml's youtubeCookiesPath, falling back
// to a youtube-cookies.txt dropped next to config.yaml. Resolved on every
// spawn so a cookies file added (or refreshed) while the app is running is
// picked up without a restart. Note yt-dlp rewrites the file on exit with
// any cookies YouTube rotated, so it must stay writable.
function youtubeCookieArgs(): string[] {
  const configuredPath = karafriendsConfig.youtubeCookiesPath;
  const cookiesPath =
    configuredPath || path.join(app.getPath("userData"), "youtube-cookies.txt");

  if (fs.existsSync(cookiesPath)) {
    return ["--cookies", cookiesPath];
  }

  if (configuredPath) {
    console.warn(
      `youtubeCookiesPath is set but ${cookiesPath} does not exist; downloading without cookies`,
    );
  }

  return [];
}

// yt-dlp only enables the "deno" JS runtime by default. With no runtime at all
// it can't run YouTube's player JS, so it falls back to clients YouTube
// bot-walls (android_vr) and warns that JS-less extraction is deprecated.
// Electron's own binary runs as plain Node when ELECTRON_RUN_AS_NODE is set
// (youtubeSpawnEnv does that for the runtime yt-dlp spawns), so we can point
// yt-dlp at it instead of shipping a separate runtime. If it somehow isn't
// usable yt-dlp just warns and carries on exactly as it does today.
function youtubeJsRuntimeArgs(): string[] {
  return ["--js-runtimes", `node:${process.execPath}`];
}

// Shared env for every yt-dlp spawn.
function youtubeSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Don't need a proxy to download from YouTube
  delete env.http_proxy;
  // Makes process.execPath behave as plain Node for the JS runtime yt-dlp
  // spawns as its own child (it inherits this env).
  env.ELECTRON_RUN_AS_NODE = "1";

  return env;
}

interface YoutubeDownloadFailure extends Error {
  rateLimited?: boolean;
}

// Breathing room before retrying a failed (but not rate-limited) YouTube
// download. The retry used to fire instantly, which meant a struggling
// YouTube got hit again immediately.
const YOUTUBE_RETRY_BACKOFF_MS = 5000;

// YouTube answers a rate-limited/bot-walled extraction the same way no matter
// how many times we ask, so an immediate retry can't succeed - it just spends
// more of the quota that got us walled in the first place. Detect those and
// skip the retry.
function isYoutubeRateLimited(log: string): boolean {
  return (
    log.includes("Sign in to confirm you") ||
    log.includes("HTTP Error 429") ||
    log.includes("Too Many Requests")
  );
}

function deleteTempFiles(prefix: string): void {
  for (const filename of fs.readdirSync(TEMP_FOLDER)) {
    if (!filename) {
      continue;
    }

    if (filename.includes(prefix)) {
      // readdirSync returns basenames - unlinking those directly would
      // resolve against cwd and throw ENOENT (failing the whole queue
      // mutation) instead of clearing the stale temp files.
      fs.unlinkSync(`${TEMP_FOLDER}/${filename}`);
    }
  }
}

function handleFFmpegDownloadLog(
  log: string,
  songFrames: number,
  downloadQueueItem: DownloadQueueItem,
): void {
  const frameMatchData = log.match(/frame=\s*(\d+)\s*/);

  if (frameMatchData) {
    const rawProgress = parseInt(frameMatchData[1], 10) / songFrames;
    const progress = Math.min(rawProgress, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

function handleYoutubeDownloadLog(
  log: string,
  downloadQueueItem: DownloadQueueItem,
): void {
  const matchData = log.match(/\[download\]\s*(\d+\.\d)%/);

  if (matchData) {
    const progress = Math.min(parseFloat(matchData[1]) / 100.0, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

function isVideoCurrentlyDownloading(
  filename: string,
  downloadQueue: DownloadQueueItem[],
  downloadType: number,
  songId: string,
  suffix: string | null = null,
): boolean {
  if (!fs.existsSync(filename)) {
    return false;
  }

  const prevDownloadQueueItem = downloadQueue.find(
    (item) =>
      item.downloadType === downloadType &&
      item.songId === songId &&
      item.suffix === suffix,
  );

  return Boolean(prevDownloadQueueItem);
}

export function getVideoDownloadProgress(
  downloadQueue: DownloadQueueItem[],
  downloadType: number,
  songId: string,
  suffix: string | null = null,
): number {
  const downloadQueueItem = downloadQueue.find(
    (item) =>
      item.downloadType === downloadType &&
      item.songId === songId &&
      item.suffix === suffix,
  );

  if (downloadQueueItem) {
    return downloadQueueItem.progress;
  }

  return -1.0;
}

function removeVideoDownloadFromQueue(
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
): void {
  const index = downloadQueue.indexOf(downloadQueueItem);
  if (index !== -1) {
    downloadQueue.splice(index, 1);
  }
}

function getJoysoundOggPlaytime(oggBuffer: Buffer): number {
  const FIELD_TAG = new Uint8Array([
    0x70, 0x6c, 0x61, 0x79, 0x74, 0x69, 0x6d, 0x65, 0x3d,
  ]);

  let fieldOffset = 0;
  let fieldLength = 0;

  for (let i = 0; i < oggBuffer.length; i++) {
    const oggSlice = oggBuffer.subarray(i, i + FIELD_TAG.length);

    let isFieldTag = true;

    for (let j = 0; j < oggSlice.length; j++) {
      if (oggSlice[j] !== FIELD_TAG[j]) {
        isFieldTag = false;
        break;
      }
    }

    if (!isFieldTag) {
      continue;
    }

    fieldOffset = i + FIELD_TAG.length;

    const fieldLengthView = new DataView(oggBuffer.buffer, i - 4, 4);
    fieldLength = fieldLengthView.getUint32(0, true) - FIELD_TAG.length;

    break;
  }

  const playtimeBuffer = oggBuffer.subarray(
    fieldOffset,
    fieldOffset + fieldLength,
  );

  let playtimeString = "";

  for (const char of playtimeBuffer) {
    playtimeString += String.fromCharCode(char);
  }

  return parseInt(playtimeString, 10);
}

export function downloadDamVideo(
  m3u8Url: string,
  songId: string,
  suffix: string,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filename = `${TEMP_FOLDER}/${songId}-${suffix}.mp4`;
  const tempFilename = `${filename}.tmp`;

  if (fs.existsSync(filename)) {
    console.info(`${filename} already exists, not redownloading`);
    return;
  }

  console.info(`Downloading DAM video to ${filename}`);

  const ffmpegLogFilename = `${TEMP_FOLDER}/dam-${songId}.log`;
  const ffmpegLogStream = fs.createWriteStream(ffmpegLogFilename);

  const ffmpeg = spawn(
    resourcePaths.ffmpeg,
    [
      "-y",
      "-i",
      m3u8Url,
      "-c",
      "copy",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      tempFilename,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  invariant(ffmpeg.stdout);
  invariant(ffmpeg.stderr);
  ffmpeg.stdout.pipe(process.stdout);
  ffmpeg.stdout.pipe(ffmpegLogStream);
  ffmpeg.stderr.pipe(process.stderr);
  ffmpeg.stderr.pipe(ffmpegLogStream);

  ffmpeg.on("exit", (code, signal) => {
    if (code === 0) {
      fs.renameSync(tempFilename, filename);
    } else {
      console.error(
        `Error downloading DAM video with ID ${songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
      );
      if (fs.existsSync(tempFilename)) {
        fs.unlinkSync(tempFilename);
      }
    }
  });
}

function makeJoysoundFFmpegCall(
  songId: string,
  ffmpegArgs: string[],
  ffmpegLogFilename: string,
  onStderrData: null | ((data: Buffer) => any),
  onExit: null | ((code: number, signal: number) => any),
  stdinBuffer: Buffer | string | null,
): void {
  const ffmpegLogStream = fs.createWriteStream(ffmpegLogFilename, {
    flags: "a",
  });

  const ffmpeg = spawn(resourcePaths.ffmpeg, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  invariant(ffmpeg.stdin);
  invariant(ffmpeg.stdout);
  invariant(ffmpeg.stderr);

  ffmpeg.stdout.pipe(process.stdout);
  ffmpeg.stdout.pipe(ffmpegLogStream);
  ffmpeg.stderr.pipe(process.stderr);
  ffmpeg.stderr.pipe(ffmpegLogStream);

  if (onStderrData) {
    ffmpeg.stderr.on("data", onStderrData);
  }

  if (onExit) {
    ffmpeg.on("exit", onExit);
    // If ffmpeg fails to even launch (e.g. missing binary), Node emits
    // "error" instead of "exit" - without this, callers relying on onExit
    // to reject/clean up would otherwise hang forever.
    ffmpeg.on("error", (err) => {
      console.error(
        `Error spawning ffmpeg for songId ${songId}: ${err.message}`,
      );
      onExit(-1, 0);
    });
  }

  if (stdinBuffer) {
    // See decodeToPcm's identical guard: an unhandled stdin stream "error"
    // (e.g. EPIPE if ffmpeg exits early) crashes the process, not just this
    // call - the onExit/error handlers above already report/reject.
    ffmpeg.stdin.on("error", () => undefined);
    ffmpeg.stdin.write(stdinBuffer);
    ffmpeg.stdin.end();
  }
}

function downloadJoysoundVideoPromise(
  songId: string,
  videoUrl: string,
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
  ffmpegLogFilename: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let songFrames = 0;

    const ffmpegArgs = [
      "-i",
      videoUrl,
      "-c",
      "copy",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      "-y",
      tempFilename,
    ];

    const onStderrData = (ffmpegData: Buffer) => {
      const ffmpegLog = ffmpegData.toString();

      const durationMatchData = ffmpegLog.match(
        /Duration:\s*(\d+):(\d+):(\d+)/,
      );

      if (durationMatchData) {
        let songDuration = 0;

        songDuration += parseInt(durationMatchData[1], 10) * 3600;
        songDuration += parseInt(durationMatchData[2], 10) * 60;
        songDuration += parseInt(durationMatchData[3], 10);

        songFrames = songDuration * 30;
      }

      handleFFmpegDownloadLog(ffmpegLog, songFrames, downloadQueueItem);
    };

    const onExit = (code: number, signal: number) => {
      if (code === 0) {
        resolve(code);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${songId}: url=${videoUrl}, code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      songId,
      ffmpegArgs,
      ffmpegLogFilename,
      onStderrData,
      onExit,
      null,
    );
  });
}

function downloadJoysoundYoutubeVideoPromise(
  songId: string,
  youtubeVideoId: string,
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ytdlpLogFilename = `${TEMP_FOLDER}/yt-${youtubeVideoId}.log`;
    // Append so a failed first attempt's output survives the retry's run
    // instead of being truncated away - it's the only record of why the
    // first attempt failed.
    const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename, {
      flags: "a",
    });

    let logText = "";

    const ytdlp = spawn(
      resourcePaths.ytdlp,
      [
        ...youtubeCookieArgs(),
        ...youtubeJsRuntimeArgs(),
        "-S",
        "res:720,ext:mp4",
        // Grab the audio alongside the video in this one extraction. The
        // composite itself uses the JOYSOUND ogg, not this audio, but
        // computeYoutubeIntroSync needs the MV's audio to measure the
        // offset - and pulling it here means one yt-dlp extraction per song
        // instead of two (a video-only "-f bv" fetch plus a separate "-f ba"
        // one), which is what was burning through YouTube's rate limit.
        "-f",
        "bv+ba/b",
        "--recode",
        "mp4",
        "-N",
        "4",
        "--ffmpeg-location",
        resourcePaths.ffmpeg,
        "-o",
        tempFilename + ".mp4",
        "--",
        youtubeVideoId!,
      ],
      {
        env: youtubeSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    invariant(ytdlp.stdout);
    invariant(ytdlp.stderr);

    ytdlp.stdout.pipe(process.stdout);
    ytdlp.stdout.pipe(ytdlpLogStream);
    ytdlp.stderr.pipe(process.stderr);
    ytdlp.stderr.pipe(ytdlpLogStream);

    ytdlp.stdout.on("data", (data) => {
      logText += data.toString();
      handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
    });
    ytdlp.stderr.on("data", (data) => {
      logText += data.toString();
    });

    ytdlp.on("error", (err) => {
      console.error(
        `Error spawning yt-dlp for Youtube Video with ID ${youtubeVideoId}: ${err.message}`,
      );
      reject(err);
    });

    ytdlp.on("exit", (code, signal) => {
      if (code === 0) {
        fs.unlinkSync(tempFilename);
        fs.renameSync(tempFilename + ".mp4", tempFilename);

        resolve(code);
      } else {
        console.error(
          `Error downloading Youtube Video with ID ${youtubeVideoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
        );

        const error: YoutubeDownloadFailure = new Error(
          `yt-dlp exited with code ${code}, log=${ytdlpLogFilename}`,
        );
        error.rateLimited = isYoutubeRateLimited(logText);
        reject(error);
      }
    });
  });
}

// --- YouTube video-offset detection (experimental, best-effort) ---
//
// A downloaded YouTube MV rarely lines up 1:1 with the Joysound karaoke
// track it gets composited under: the MV may open with a non-song intro
// (album art, a spoken bit, a visual hook), and the karaoke arrangement may
// itself have extra material at the head (a count-off, a longer intro) that
// the original recording doesn't. We estimate the signed offset between the
// two by cross-correlating cheap amplitude envelopes of several windows of
// the karaoke audio against the MV's own audio. Windows are sampled from
// *inside* the song rather than just its head, because the head is exactly
// where karaoke arrangements diverge most from the original (count-offs,
// re-arranged intros).
//
// The estimate runs in three stages:
//
// 1. A coarse (100ms-envelope) scan of every lag at every anchor collects
//    *all* local correlation peaks as candidate offsets - not just each
//    anchor's best match. On repetitive songs a phrase-aliased ghost offset
//    (one riff repetition away) routinely outscores the true offset at
//    coarse resolution (the Shintakarajima bug), so no single argmax can be
//    trusted; the true offset just has to make the candidate list.
// 2. Each candidate is refined on a fine (10ms) envelope drift-tolerantly:
//    every anchor reports its own best fine offset within a small window
//    around the candidate (karaoke re-recordings genuinely drift by
//    hundreds of ms across a song, so demanding one exact offset at every
//    anchor collapses honest candidates - the Zankoku-na-Tenshi-no-These
//    regression), the score-weighted median of those per-anchor peaks
//    becomes the candidate's refined offset, and its validation score is
//    the mean of the per-anchor maxima around it.
// 3. The top refined candidates are ranked by guide-melody salience: does
//    the MV's audio actually contain the guide melody's pitches at the
//    times this offset predicts (Goertzel power on-pitch vs off-pitch over
//    the first 30s of sung notes)? Envelope correlation measures "the mix
//    is loud in the same places", which phrase aliases fake convincingly;
//    the melody-vs-accompaniment distinction is what they can't fake. On
//    every measured song the melody margin between true offset and best
//    alias (>=0.37) dwarfs the envelope margin (sometimes inverted), so a
//    confident melody ranking overrides the envelope one; the envelope
//    winner (with confidence gates) is the fallback when melody data is
//    missing or its ranking is ambiguous.
//
// A positive offset means the MV has extra head material: trim it off with
// -ss when compositing. A negative offset means the karaoke track has extra
// head material: delay the video by front-padding it with its frozen first
// frame (padJoysoundVideoPromise). If no candidate survives, onset
// alignment (below) is the last resort before giving up.
//
// After an offset is chosen (by any method), measureVideoDriftAround checks
// whether the two tracks even run at the same tempo: some MV uploads are
// speed-shifted (e.g. +1.19% on Romeo-to-Cinderella 9HrOqmiEsN8, a smooth
// 3.3s of drift over the song - no constant offset can sync that). Anchors
// across the whole track each report their local best offset, a weighted
// linear fit recovers the rate difference, and the compose pipeline slows
// or speeds the video's timestamps to match (stretchJoysoundVideoPromise,
// a copy-codec -itsscale remux) before the usual trim/pad.

const INTRO_SYNC_REFERENCE_SEC = 20;
const INTRO_SYNC_MAX_DECODE_SEC = 600;
const INTRO_SYNC_MAX_OFFSET_MS = 40000;
const INTRO_SYNC_CONFIDENCE_THRESHOLD = 0.5;
const INTRO_SYNC_FIRST_ANCHOR_SEC = 10;
const INTRO_SYNC_ANCHOR_STEP_SEC = 15;
const INTRO_SYNC_LAST_ANCHOR_SEC = 120;
const INTRO_SYNC_ENVELOPE_WINDOW_MS = 100;
const INTRO_SYNC_FINE_WINDOW_MS = 10;
const INTRO_SYNC_SAMPLE_RATE_HZ = 8000;
// Candidate handling. Coarse local peaks within MERGE_MS of a stronger one
// are the same peak sampled off-grid, not a separate candidate. The
// refinement cap bounds main-process CPU on pathologically repetitive
// tracks; the worst observed true-candidate coarse rank is 20
// (Shintakarajima). DRIFT_TOLERANCE is how far an individual anchor's fine
// peak may sit from the candidate and still count as the same alignment
// (covers real tempo drift, observed up to ~150ms plus coarse-grid error;
// must stay well under the closest observed alias spacing, ~1.7s), and
// anchors whose peak stays below PEAK_VOTE_FLOOR don't vote on where the
// refined offset lands. For the envelope-only fallback decision,
// MIN_MEAN_SCORE gates the winner's mean per-anchor correlation and
// MIN_RUNNER_UP_MARGIN declares the measurement inconclusive when a
// well-separated second candidate scores nearly as well.
const INTRO_SYNC_CANDIDATE_MERGE_MS = 300;
const INTRO_SYNC_MAX_REFINE_CANDIDATES = 32;
const INTRO_SYNC_DRIFT_TOLERANCE_MS = 1000;
const INTRO_SYNC_PEAK_VOTE_FLOOR = 0.4;
const INTRO_SYNC_MIN_MEAN_SCORE = 0.5;
const INTRO_SYNC_RUNNER_UP_SEPARATION_MS = 1500;
const INTRO_SYNC_MIN_RUNNER_UP_MARGIN = 0.05;
// Guide-melody salience selection. Scores are log10(on-pitch power /
// off-pitch power) averaged over the first HEAD_NOTES_SEC of sung notes;
// observed true offsets score 1.65-2.04 and aliases 0.69-1.28, so MIN_SCORE
// rejects rankings where nothing really matches (e.g. a transposed or live
// MV) and MIN_MARGIN rejects ambiguous ones (observed true margins:
// 0.37-0.99) - both fall back to the envelope decision.
const INTRO_SYNC_MELODY_TOP_K = 8;
const INTRO_SYNC_MELODY_HEAD_NOTES_SEC = 30;
const INTRO_SYNC_MELODY_MIN_SCORE = 1.0;
const INTRO_SYNC_MELODY_MIN_MARGIN = 0.3;
// Onset-alignment fallback (used when the interior-window cross-correlation
// can't reach a confident consensus - which is the common case, because a
// JOYSOUND karaoke re-recording rarely envelope-correlates with the original
// master). We detect where the music actually starts in each track and align
// those points. ONSET_HEAD_SEC bounds the region used to establish the loud
// reference level; ONSET_THRESHOLD_FRAC of that level marks "music has
// started"; ONSET_SMOOTH_MS smooths out transient clicks before the crossing.
const INTRO_SYNC_ONSET_HEAD_SEC = 90;
const INTRO_SYNC_ONSET_THRESHOLD_FRAC = 0.15;
const INTRO_SYNC_ONSET_SMOOTH_MS = 300;
// Tempo-drift measurement (speed-shifted MV uploads). Shorter reference
// windows than refinement (a 20s window smears ~240ms internally at ~1.2%
// drift, flattening the very peaks being measured), and a much lower peak
// floor: drift-smeared honest peaks legitimately score only 0.13-0.28, and
// it's the robust line fit - not the floor - that rejects garbage
// (unrelated peaks don't fall on a line). Collection windows are centered
// on the caller's offset and widen with anchor position: they must absorb
// the seed's own error (up to SEED_TOLERANCE - a seed chosen assuming
// constant offset sits mid-drift, over a second off the head alignment)
// plus drift accumulated at up to RATE_SCAN_BOUND. Line selection is
// RANSAC-style because no single per-anchor argmax can be trusted (same
// lesson as the coarse candidate scan): on Romeo-to-Cinderella a phrase
// alias near the video head outscored every honest peak 0.57-vs-0.2 and a
// greedy walk seeded on it nulled the whole measurement. Pair hypotheses
// include same-track (constant, slope ~0) lines, so a non-drifting song
// resolves to a sub-MIN_RATE slope and no stretch. Fit gates: enough
// voters over a long enough baseline for the rate to be trustworthy,
// residuals small enough that the drift is actually linear, and rate
// bounds - below MIN_RATE a constant offset is within normal karaoke
// wander (~0.1%) so don't touch the video, above MAX_RATE it's not a
// speed-shift, it's a different arrangement.
const INTRO_SYNC_DRIFT_REFERENCE_SEC = 8;
const INTRO_SYNC_DRIFT_SEED_TOLERANCE_MS = 2500;
const INTRO_SYNC_DRIFT_RATE_SCAN_BOUND = 0.02;
const INTRO_SYNC_DRIFT_PEAK_FLOOR = 0.12;
const INTRO_SYNC_DRIFT_PEAKS_PER_ANCHOR = 8;
const INTRO_SYNC_DRIFT_PEAK_SEPARATION_MS = 400;
const INTRO_SYNC_DRIFT_MIN_BASELINE_MS = 60000;
const INTRO_SYNC_DRIFT_INLIER_TOLERANCE_MS = 250;
const INTRO_SYNC_DRIFT_FINE_TOLERANCE_MS = 300;
const INTRO_SYNC_DRIFT_MIN_VOTERS = 8;
const INTRO_SYNC_DRIFT_MIN_SPAN_MS = 120000;
const INTRO_SYNC_DRIFT_MAX_RESIDUAL_MS = 250;
const INTRO_SYNC_DRIFT_MIN_RATE = 0.003;
const INTRO_SYNC_DRIFT_MAX_RATE = 0.05;

// Decodes an audio file or in-memory buffer to raw mono PCM at
// INTRO_SYNC_SAMPLE_RATE_HZ, capped to maxDurationSec of output.
function decodeToPcm(
  input: string | Buffer,
  maxDurationSec: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      resourcePaths.ffmpeg,
      [
        "-i",
        typeof input === "string" ? input : "-",
        "-t",
        maxDurationSec.toString(),
        "-ac",
        "1",
        "-ar",
        INTRO_SYNC_SAMPLE_RATE_HZ.toString(),
        "-f",
        "s16le",
        "-",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );

    invariant(ffmpeg.stdin);
    invariant(ffmpeg.stdout);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    ffmpeg.on("error", reject);
    ffmpeg.on("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg PCM decode exited with code ${code}`));
      }
    });

    // If ffmpeg exits (or never starts reading) while we're still writing a
    // large buffer to its stdin, Node emits an "error" (e.g. EPIPE) on the
    // stdin stream itself, not on the ChildProcess - left unhandled, that's
    // an uncaught exception that crashes the whole process rather than just
    // rejecting this promise. The process-level "error"/"exit" handlers
    // above already report/reject appropriately.
    ffmpeg.stdin.on("error", () => undefined);

    if (typeof input !== "string") {
      ffmpeg.stdin.write(input);
    }
    ffmpeg.stdin.end();
  });
}

function computeRmsEnvelope(pcm: Buffer, windowMs: number): number[] {
  const windowSamples = Math.round(
    (windowMs / 1000) * INTRO_SYNC_SAMPLE_RATE_HZ,
  );
  const windowBytes = windowSamples * 2; // 16-bit samples
  const envelope: number[] = [];

  for (
    let offset = 0;
    offset + windowBytes <= pcm.length;
    offset += windowBytes
  ) {
    let sumSquares = 0;
    for (let i = offset; i < offset + windowBytes; i += 2) {
      const sample = pcm.readInt16LE(i);
      sumSquares += sample * sample;
    }
    envelope.push(Math.sqrt(sumSquares / windowSamples));
  }

  return envelope;
}

function pearsonCorrelationAt(
  a: number[],
  aStart: number,
  b: number[],
  bStart: number,
  n: number,
): number {
  if (n === 0) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[aStart + i];
    sumB += b[bStart + i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[aStart + i] - meanA;
    const db = b[bStart + i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }

  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : numerator / denom;
}

interface OffsetCandidate {
  offsetMs: number;
  score: number;
}

// Anchor positions (ms into the karaoke track) at which
// INTRO_SYNC_REFERENCE_SEC-long comparison windows are taken.
function anchorPositionsMs(karaokeEnvelope: number[]): number[] {
  const windowMs = INTRO_SYNC_ENVELOPE_WINDOW_MS;
  const referenceWindows = (INTRO_SYNC_REFERENCE_SEC * 1000) / windowMs;

  const anchorsMs: number[] = [];
  for (
    let anchorSec = INTRO_SYNC_FIRST_ANCHOR_SEC;
    anchorSec <= INTRO_SYNC_LAST_ANCHOR_SEC &&
    (anchorSec * 1000) / windowMs + referenceWindows <= karaokeEnvelope.length;
    anchorSec += INTRO_SYNC_ANCHOR_STEP_SEC
  ) {
    anchorsMs.push(anchorSec * 1000);
  }
  // Very short track: fall back to matching what we have from the head.
  if (anchorsMs.length === 0 && referenceWindows <= karaokeEnvelope.length) {
    anchorsMs.push(0);
  }
  return anchorsMs;
}

// Per-anchor best fine-envelope match near a candidate offset: each anchor
// reports the offset (within DRIFT_TOLERANCE of the candidate) where it
// correlates best, and how well. This is what makes refinement
// drift-tolerant - anchors vote on where the alignment is instead of being
// scored against one exact offset. Do NOT score a candidate by taking a
// window-max around an arbitrary center instead: that makes the score flat
// across the whole window and even rewards centers that straddle two alias
// tracks, catching each anchor's peak from whichever track is closer.
function anchorFinePeaksAround(
  karaokeFineEnvelope: number[],
  videoFineEnvelope: number[],
  anchorsMs: number[],
  centerMs: number,
): OffsetCandidate[] {
  const windowMs = INTRO_SYNC_FINE_WINDOW_MS;
  const referenceWindows = (INTRO_SYNC_REFERENCE_SEC * 1000) / windowMs;

  const peaks: OffsetCandidate[] = [];
  for (const anchorMs of anchorsMs) {
    const anchorWindows = anchorMs / windowMs;
    if (anchorWindows + referenceWindows > karaokeFineEnvelope.length) {
      continue;
    }
    let best: OffsetCandidate | null = null;
    for (
      let offsetMs = centerMs - INTRO_SYNC_DRIFT_TOLERANCE_MS;
      offsetMs <= centerMs + INTRO_SYNC_DRIFT_TOLERANCE_MS;
      offsetMs += windowMs
    ) {
      const videoStart = anchorWindows + offsetMs / windowMs;
      if (
        videoStart < 0 ||
        videoStart + referenceWindows > videoFineEnvelope.length
      ) {
        continue;
      }
      const score = pearsonCorrelationAt(
        karaokeFineEnvelope,
        anchorWindows,
        videoFineEnvelope,
        videoStart,
        referenceWindows,
      );
      if (best === null || score > best.score) {
        best = { offsetMs, score };
      }
    }
    if (best !== null) {
      peaks.push(best);
    }
  }
  return peaks;
}

// Median of the anchors' peak offsets, weighted by their correlation - the
// consensus alignment among anchors that actually matched something.
function weightedMedianOffsetMs(peaks: OffsetCandidate[]): number {
  const sorted = [...peaks].sort((a, b) => a.offsetMs - b.offsetMs);
  const total = sorted.reduce((acc, peak) => acc + peak.score, 0);
  let cumulative = 0;
  for (const peak of sorted) {
    cumulative += peak.score;
    if (cumulative >= total / 2) {
      return peak.offsetMs;
    }
  }
  return sorted[sorted.length - 1].offsetMs;
}

// Stages 1+2 (see the block comment above the constants): coarse candidate
// collection, then drift-tolerant fine refinement + validation. Returns
// refined candidates ranked by mean per-anchor envelope correlation,
// deduplicated so entries are genuinely distinct alignments (at least
// RUNNER_UP_SEPARATION apart). Offsets are video-minus-karaoke ms
// (positive: video has extra head material; negative: karaoke does).
function estimateVideoOffsetCandidates(
  karaokeEnvelope: number[],
  videoEnvelope: number[],
  karaokeFineEnvelope: number[],
  videoFineEnvelope: number[],
): OffsetCandidate[] {
  const windowMs = INTRO_SYNC_ENVELOPE_WINDOW_MS;
  const referenceWindows = (INTRO_SYNC_REFERENCE_SEC * 1000) / windowMs;
  const anchorsMs = anchorPositionsMs(karaokeEnvelope);

  // Stage 1: coarse scan. Keep every local correlation peak as a candidate,
  // not just each anchor's best - on repetitive songs the true offset often
  // sits *behind* a phrase-aliased ghost at coarse resolution.
  const candidates: OffsetCandidate[] = [];
  for (const anchorMs of anchorsMs) {
    const anchorWindows = anchorMs / windowMs;
    if (anchorWindows + referenceWindows > karaokeEnvelope.length) {
      continue;
    }

    const scores: number[] = [];
    for (let lag = 0; lag + referenceWindows <= videoEnvelope.length; lag++) {
      scores.push(
        pearsonCorrelationAt(
          karaokeEnvelope,
          anchorWindows,
          videoEnvelope,
          lag,
          referenceWindows,
        ),
      );
    }

    for (let lag = 1; lag + 1 < scores.length; lag++) {
      const offsetMs = (lag - anchorWindows) * windowMs;
      if (
        Math.abs(offsetMs) <= INTRO_SYNC_MAX_OFFSET_MS &&
        scores[lag] >= INTRO_SYNC_CONFIDENCE_THRESHOLD &&
        scores[lag] >= scores[lag - 1] &&
        scores[lag] >= scores[lag + 1]
      ) {
        candidates.push({ offsetMs, score: scores[lag] });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const merged: OffsetCandidate[] = [];
  for (const candidate of candidates) {
    if (merged.length >= INTRO_SYNC_MAX_REFINE_CANDIDATES) {
      break;
    }
    if (
      merged.every(
        (m) =>
          Math.abs(m.offsetMs - candidate.offsetMs) >
          INTRO_SYNC_CANDIDATE_MERGE_MS,
      )
    ) {
      merged.push(candidate);
    }
  }

  // Stage 2: drift-tolerant refinement. Each anchor votes on where the
  // alignment near this candidate really is (also fixing the coarse grid's
  // 100ms quantization, which is audible); the weighted median of the votes
  // is the refined offset, validated by re-collecting per-anchor maxima
  // around it.
  const refined: OffsetCandidate[] = [];
  for (const candidate of merged) {
    const peaks = anchorFinePeaksAround(
      karaokeFineEnvelope,
      videoFineEnvelope,
      anchorsMs,
      candidate.offsetMs,
    );
    // A candidate scored on a cherry-picked remnant of anchors can't win.
    if (peaks.length < Math.ceil(anchorsMs.length / 2)) {
      continue;
    }
    const voters = peaks.filter(
      (peak) => peak.score >= INTRO_SYNC_PEAK_VOTE_FLOOR,
    );
    if (voters.length === 0) {
      continue;
    }
    const offsetMs = weightedMedianOffsetMs(voters);
    if (Math.abs(offsetMs) > INTRO_SYNC_MAX_OFFSET_MS) {
      continue;
    }

    const validationPeaks = anchorFinePeaksAround(
      karaokeFineEnvelope,
      videoFineEnvelope,
      anchorsMs,
      offsetMs,
    );
    if (validationPeaks.length < Math.ceil(anchorsMs.length / 2)) {
      continue;
    }
    const score =
      validationPeaks.reduce((acc, peak) => acc + peak.score, 0) /
      validationPeaks.length;
    refined.push({ offsetMs, score });
  }
  refined.sort((a, b) => b.score - a.score);

  // Nearby candidates routinely refine onto the same alignment; keep only
  // genuinely distinct ones.
  const separated: OffsetCandidate[] = [];
  for (const candidate of refined) {
    if (
      separated.every(
        (s) =>
          Math.abs(s.offsetMs - candidate.offsetMs) >
          INTRO_SYNC_RUNNER_UP_SEPARATION_MS,
      )
    ) {
      separated.push(candidate);
    }
  }
  return separated;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Goertzel power of one frequency over a PCM span - O(n) per probe
// frequency, so no FFT machinery is needed for the handful of probes per
// note.
function goertzelPower(
  pcm: Float64Array,
  startSample: number,
  endSample: number,
  freqHz: number,
): number {
  const omega = (2 * Math.PI * freqHz) / INTRO_SYNC_SAMPLE_RATE_HZ;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = startSample; i < endSample; i++) {
    const s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const sampleCount = endSample - startSample;
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (sampleCount * sampleCount);
}

// log10 ratio of on-pitch to off-pitch power for one guide note mapped onto
// the video's audio. On-pitch probes the note's fundamental and the octave
// above (the sung melody sits at one or the other relative to the guide
// synth's register) with +-25-cent slack for vibrato/tuning; off-pitch
// probes +-1.5/+-2.5 semitones - close enough to share the local spectral
// tilt, but never part of the same sung note. Null when the mapped span is
// too short to resolve or the probes would exceed Nyquist.
function noteSalienceAt(
  videoPcm: Float64Array,
  startSample: number,
  endSample: number,
  midi: number,
): number | null {
  if (endSample - startSample < INTRO_SYNC_SAMPLE_RATE_HZ / 20) return null;
  if (midiToHz(midi + 12.25) >= INTRO_SYNC_SAMPLE_RATE_HZ / 2) return null;

  let onPower = 0;
  for (const octave of [0, 12]) {
    for (const cents of [-25, 0, 25]) {
      onPower = Math.max(
        onPower,
        goertzelPower(
          videoPcm,
          startSample,
          endSample,
          midiToHz(midi + octave + cents / 100),
        ),
      );
    }
  }

  let offPower = 0;
  let offCount = 0;
  for (const octave of [0, 12]) {
    for (const semis of [-2.5, -1.5, 1.5, 2.5]) {
      offPower += goertzelPower(
        videoPcm,
        startSample,
        endSample,
        midiToHz(midi + octave + semis),
      );
      offCount++;
    }
  }

  return Math.log10((onPower + 1e-9) / (offPower / offCount + 1e-9));
}

// Mean note salience of a candidate offset: do the guide melody's pitches
// actually sound in the video's audio at the times this offset predicts?
// Null when fewer than half the notes could be scored (offset maps them
// outside the video).
function melodySalienceAt(
  videoPcm: Float64Array,
  headNotes: GuideMelodyNote[],
  offsetMs: number,
): number | null {
  let sum = 0;
  let count = 0;
  for (const note of headNotes) {
    const startSample = Math.round(
      ((note.startMs + offsetMs) / 1000) * INTRO_SYNC_SAMPLE_RATE_HZ,
    );
    const endSample = Math.round(
      ((note.endMs + offsetMs) / 1000) * INTRO_SYNC_SAMPLE_RATE_HZ,
    );
    if (startSample < 0 || endSample > videoPcm.length) {
      continue;
    }
    const salience = noteSalienceAt(
      videoPcm,
      startSample,
      endSample,
      note.midi,
    );
    if (salience !== null) {
      sum += salience;
      count++;
    }
  }
  return count < headNotes.length / 2 ? null : sum / count;
}

// Stage 3 + final decision (see the block comment above the constants):
// melody-salience ranking with confidence gates, falling back to the
// envelope ranking with its own gates. Null means nothing was confident
// enough - the caller falls through to onset alignment.
function chooseVideoOffset(
  candidates: OffsetCandidate[],
  videoPcm: Float64Array,
  guideMelodyNotes: GuideMelodyNote[] | null,
): { offsetMs: number; method: string } | null {
  if (candidates.length === 0) {
    return null;
  }

  if (guideMelodyNotes !== null && guideMelodyNotes.length > 0) {
    const firstNoteMs = guideMelodyNotes[0].startMs;
    const headNotes = guideMelodyNotes.filter(
      (note) =>
        note.startMs < firstNoteMs + INTRO_SYNC_MELODY_HEAD_NOTES_SEC * 1000,
    );
    const ranked = candidates
      .slice(0, INTRO_SYNC_MELODY_TOP_K)
      .flatMap((candidate) => {
        const melody = melodySalienceAt(
          videoPcm,
          headNotes,
          candidate.offsetMs,
        );
        return melody === null ? [] : [{ candidate, melody }];
      })
      .sort((a, b) => b.melody - a.melody);
    if (
      ranked.length > 0 &&
      ranked[0].melody >= INTRO_SYNC_MELODY_MIN_SCORE &&
      (ranked.length < 2 ||
        ranked[0].melody - ranked[1].melody >= INTRO_SYNC_MELODY_MIN_MARGIN)
    ) {
      return { offsetMs: ranked[0].candidate.offsetMs, method: "melody" };
    }
  }

  // Envelope fallback. Candidates arrive separated, so the runner-up for
  // the ambiguity check is simply the next entry.
  const winner = candidates[0];
  if (winner.score < INTRO_SYNC_MIN_MEAN_SCORE) {
    return null;
  }
  const runnerUp = candidates[1];
  if (
    runnerUp &&
    winner.score - runnerUp.score < INTRO_SYNC_MIN_RUNNER_UP_MARGIN
  ) {
    return null;
  }
  return { offsetMs: winner.offsetMs, method: "correlation" };
}

// First window whose trailing smoothed RMS crosses a fraction of the
// head-region peak - i.e. where the music actually starts. Null if the track
// never rises above the floor (effectively silent). Robust across differing
// arrangements/mixes because it keys off "sound started", not waveform shape.
function detectMusicOnsetWindows(envelope: number[]): number | null {
  if (envelope.length === 0) return null;

  const windowMs = INTRO_SYNC_ENVELOPE_WINDOW_MS;
  const headWindows = Math.min(
    envelope.length,
    (INTRO_SYNC_ONSET_HEAD_SEC * 1000) / windowMs,
  );

  let peak = 0;
  for (let i = 0; i < headWindows; i++) {
    if (envelope[i] > peak) peak = envelope[i];
  }
  if (peak <= 0) return null;

  const threshold = peak * INTRO_SYNC_ONSET_THRESHOLD_FRAC;
  const smoothWindows = Math.max(
    1,
    Math.round(INTRO_SYNC_ONSET_SMOOTH_MS / windowMs),
  );

  let sum = 0;
  for (let i = 0; i < envelope.length; i++) {
    sum += envelope[i];
    if (i >= smoothWindows) sum -= envelope[i - smoothWindows];
    const avg = sum / Math.min(i + 1, smoothWindows);
    if (avg >= threshold) return Math.max(0, i - smoothWindows + 1);
  }

  return null;
}

// Fallback for when cross-correlation is inconclusive: align the two tracks by
// where each one's music starts. Returns the signed offset in ms with the same
// convention as estimateVideoOffsetMs (positive: video has extra head material
// to trim; negative: karaoke does, so delay the video), or null if either
// onset can't be located or the gap exceeds the sane maximum.
function estimateOnsetOffsetMs(
  karaokeEnvelope: number[],
  videoEnvelope: number[],
): number | null {
  const karaokeOnset = detectMusicOnsetWindows(karaokeEnvelope);
  const videoOnset = detectMusicOnsetWindows(videoEnvelope);
  if (karaokeOnset === null || videoOnset === null) return null;

  const offsetMs = (videoOnset - karaokeOnset) * INTRO_SYNC_ENVELOPE_WINDOW_MS;
  if (Math.abs(offsetMs) > INTRO_SYNC_MAX_OFFSET_MS) return null;

  return offsetMs;
}

// What computeYoutubeIntroSync hands back to the compose pipeline: multiply
// the video's timestamps by videoStretchFactor (ffmpeg -itsscale, 1 = leave
// alone), then apply offsetMs (same sign convention as before: positive =
// trim the video head, negative = front-pad it).
interface IntroSyncMeasurement {
  offsetMs: number;
  videoStretchFactor: number;
}

interface DriftPeak {
  anchorMs: number;
  offsetMs: number;
  score: number;
}

// Weighted least-squares line through (anchorMs, offsetMs) points; null on a
// degenerate spread.
function fitOffsetLine(
  points: DriftPeak[],
): { slope: number; intercept: number } | null {
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  let sumWXX = 0;
  let sumWXY = 0;
  for (const point of points) {
    sumW += point.score;
    sumWX += point.score * point.anchorMs;
    sumWY += point.score * point.offsetMs;
    sumWXX += point.score * point.anchorMs * point.anchorMs;
    sumWXY += point.score * point.anchorMs * point.offsetMs;
  }
  const denom = sumW * sumWXX - sumWX * sumWX;
  if (denom === 0) return null;
  const slope = (sumW * sumWXY - sumWX * sumWY) / denom;
  return { slope, intercept: (sumWY - slope * sumWX) / sumW };
}

// Measures linear tempo drift between the karaoke track and the video
// around an already-chosen offset. Anchors step through the WHOLE karaoke
// track (unlike candidate refinement's first-120s anchors - a rate needs a
// long baseline). Three phases:
//
// 1. Collection (coarse envelope): each anchor keeps its top few separated
//    local correlation peaks inside a window around the seed offset that
//    widens with anchor position (drift accumulates; the seed itself may be
//    over a second off). ALL peaks are kept, not each anchor's argmax - an
//    alias can outscore the honest peak at any single anchor.
// 2. Robust line selection: every pair of peaks with a long enough baseline
//    proposes a line; the line with the most inlier weight wins. Aliased
//    peaks are scattered or parallel, so they can't out-vote the true
//    track; on a non-drifting song the winning line comes from same-track
//    pairs and its slope lands under MIN_RATE (-> no stretch).
// 3. Refinement (fine envelope): each anchor re-votes within a small window
//    around the winning line, and a weighted least-squares fit of those
//    votes gives the final rate, gated on voter count, baseline span,
//    residual RMS, and rate bounds.
//
// Sign bookkeeping: with offset(k) = intercept + slope*k measured at
// karaoke time k, the video runs 1/(1+slope) times as fast as the karaoke,
// so its timestamps must be scaled by F = 1/(1+slope); after that stretch
// the remaining offset is constant at F*intercept (the drift-corrected
// head alignment).
function measureVideoDriftAround(
  karaokeEnvelope: number[],
  videoEnvelope: number[],
  karaokeFineEnvelope: number[],
  videoFineEnvelope: number[],
  offsetMs: number,
): IntroSyncMeasurement | null {
  const coarseMs = INTRO_SYNC_ENVELOPE_WINDOW_MS;
  const fineMs = INTRO_SYNC_FINE_WINDOW_MS;
  const coarseReference = (INTRO_SYNC_DRIFT_REFERENCE_SEC * 1000) / coarseMs;
  const fineReference = (INTRO_SYNC_DRIFT_REFERENCE_SEC * 1000) / fineMs;

  const anchorsMs: number[] = [];
  for (
    let anchorMs = INTRO_SYNC_FIRST_ANCHOR_SEC * 1000;
    anchorMs / fineMs + fineReference <= karaokeFineEnvelope.length;
    anchorMs += INTRO_SYNC_ANCHOR_STEP_SEC * 1000
  ) {
    anchorsMs.push(anchorMs);
  }

  // Phase 1: coarse peak collection.
  const peaks: DriftPeak[] = [];
  for (const anchorMs of anchorsMs) {
    const anchorWindows = anchorMs / coarseMs;
    if (anchorWindows + coarseReference > karaokeEnvelope.length) continue;

    const halfSpanMs =
      INTRO_SYNC_DRIFT_SEED_TOLERANCE_MS +
      INTRO_SYNC_DRIFT_RATE_SCAN_BOUND * anchorMs;
    const firstProbe = Math.round((offsetMs - halfSpanMs) / coarseMs);
    const lastProbe = Math.round((offsetMs + halfSpanMs) / coarseMs);
    const scored: OffsetCandidate[] = [];
    for (let probe = firstProbe; probe <= lastProbe; probe++) {
      const videoStart = anchorWindows + probe;
      if (
        videoStart < 0 ||
        videoStart + coarseReference > videoEnvelope.length
      ) {
        continue;
      }
      scored.push({
        offsetMs: probe * coarseMs,
        score: pearsonCorrelationAt(
          karaokeEnvelope,
          anchorWindows,
          videoEnvelope,
          videoStart,
          coarseReference,
        ),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const kept: OffsetCandidate[] = [];
    for (const candidate of scored) {
      if (candidate.score < INTRO_SYNC_DRIFT_PEAK_FLOOR) break;
      if (kept.length >= INTRO_SYNC_DRIFT_PEAKS_PER_ANCHOR) break;
      if (
        kept.every(
          (k) =>
            Math.abs(k.offsetMs - candidate.offsetMs) >=
            INTRO_SYNC_DRIFT_PEAK_SEPARATION_MS,
        )
      ) {
        kept.push(candidate);
      }
    }
    for (const candidate of kept) {
      peaks.push({ anchorMs, ...candidate });
    }
  }

  // Phase 2: RANSAC line selection over the collected peaks.
  let bestLine: { slope: number; intercept: number } | null = null;
  let bestInlierWeight = 0;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const baseline = peaks[j].anchorMs - peaks[i].anchorMs;
      if (Math.abs(baseline) < INTRO_SYNC_DRIFT_MIN_BASELINE_MS) continue;
      const slope = (peaks[j].offsetMs - peaks[i].offsetMs) / baseline;
      if (Math.abs(slope) > INTRO_SYNC_DRIFT_MAX_RATE) continue;
      const intercept = peaks[i].offsetMs - slope * peaks[i].anchorMs;
      let inlierWeight = 0;
      for (const peak of peaks) {
        if (
          Math.abs(peak.offsetMs - (intercept + slope * peak.anchorMs)) <=
          INTRO_SYNC_DRIFT_INLIER_TOLERANCE_MS
        ) {
          inlierWeight += peak.score;
        }
      }
      if (inlierWeight > bestInlierWeight) {
        bestInlierWeight = inlierWeight;
        bestLine = { slope, intercept };
      }
    }
  }
  if (bestLine === null) return null;

  // Phase 3: fine refinement along the winning line.
  const voters: DriftPeak[] = [];
  for (const anchorMs of anchorsMs) {
    const anchorWindows = anchorMs / fineMs;
    const predictedMs = bestLine.intercept + bestLine.slope * anchorMs;
    const firstProbe = Math.round(
      (predictedMs - INTRO_SYNC_DRIFT_FINE_TOLERANCE_MS) / fineMs,
    );
    const lastProbe = Math.round(
      (predictedMs + INTRO_SYNC_DRIFT_FINE_TOLERANCE_MS) / fineMs,
    );
    let best: OffsetCandidate | null = null;
    for (let probe = firstProbe; probe <= lastProbe; probe++) {
      const videoStart = anchorWindows + probe;
      if (
        videoStart < 0 ||
        videoStart + fineReference > videoFineEnvelope.length
      ) {
        continue;
      }
      const score = pearsonCorrelationAt(
        karaokeFineEnvelope,
        anchorWindows,
        videoFineEnvelope,
        videoStart,
        fineReference,
      );
      if (best === null || score > best.score) {
        best = { offsetMs: probe * fineMs, score };
      }
    }
    if (best !== null && best.score >= INTRO_SYNC_DRIFT_PEAK_FLOOR) {
      voters.push({ anchorMs, ...best });
    }
  }

  if (voters.length < INTRO_SYNC_DRIFT_MIN_VOTERS) return null;
  if (
    voters[voters.length - 1].anchorMs - voters[0].anchorMs <
    INTRO_SYNC_DRIFT_MIN_SPAN_MS
  ) {
    return null;
  }
  const fit = fitOffsetLine(voters);
  if (fit === null || Math.abs(fit.slope) > INTRO_SYNC_DRIFT_MAX_RATE) {
    return null;
  }

  let weightSum = 0;
  let residualSumSquares = 0;
  for (const voter of voters) {
    const residual =
      voter.offsetMs - (fit.intercept + fit.slope * voter.anchorMs);
    weightSum += voter.score;
    residualSumSquares += voter.score * residual * residual;
  }
  const residualRms = Math.sqrt(residualSumSquares / weightSum);
  if (residualRms > INTRO_SYNC_DRIFT_MAX_RESIDUAL_MS) {
    return null;
  }

  const videoStretchFactor = 1 / (1 + fit.slope);
  if (Math.abs(videoStretchFactor - 1) < INTRO_SYNC_DRIFT_MIN_RATE) {
    return null;
  }
  console.info(
    `measureVideoDriftAround: rate=${(fit.slope * 100).toFixed(3)}% stretch=${videoStretchFactor.toFixed(5)} voters=${voters.length} residualRms=${residualRms.toFixed(0)}ms`,
  );
  return {
    offsetMs: Math.round(videoStretchFactor * fit.intercept),
    videoStretchFactor,
  };
}

// Estimates how a YouTube video's audio lines up with the Joysound karaoke
// track: a signed head offset (ms) plus a timestamp stretch factor for
// speed-shifted uploads. offsetMs positive: the video has extra head
// material that should be trimmed. Negative: the karaoke track has extra
// head material, so the video should be delayed. Null: no confident
// estimate.
//
// videoFilename is the MV yt-dlp already downloaded (audio included, see the
// "-f bv+ba/b" fetch): reading its audio off disk keeps this to zero extra
// YouTube requests. It used to re-download the same video's audio with a
// second "-f ba" extraction, which doubled our request volume per song and
// helped earn us HTTP 429s.
//
// guideMelodyNotes (when available - i.e. the song has a usable guide
// melody channel) powers the melody-salience candidate selection; without
// it, selection falls back to envelope correlation alone.
export async function computeYoutubeIntroSync(
  oggBuffer: Buffer,
  videoFilename: string,
  guideMelodyNotes: GuideMelodyNote[] | null = null,
): Promise<IntroSyncMeasurement | null> {
  try {
    const [videoPcm, karaokePcm] = await Promise.all([
      decodeToPcm(videoFilename, INTRO_SYNC_MAX_DECODE_SEC),
      decodeToPcm(oggBuffer, INTRO_SYNC_MAX_DECODE_SEC),
    ]);

    const karaokeEnvelope = computeRmsEnvelope(
      karaokePcm,
      INTRO_SYNC_ENVELOPE_WINDOW_MS,
    );
    const videoEnvelope = computeRmsEnvelope(
      videoPcm,
      INTRO_SYNC_ENVELOPE_WINDOW_MS,
    );
    const karaokeFineEnvelope = computeRmsEnvelope(
      karaokePcm,
      INTRO_SYNC_FINE_WINDOW_MS,
    );
    const videoFineEnvelope = computeRmsEnvelope(
      videoPcm,
      INTRO_SYNC_FINE_WINDOW_MS,
    );

    // Cross-correlation generates the candidates: it can see through a loud
    // non-musical intro (spoken bit, ambient) that would fool onset
    // detection. Melody salience picks among them when it can. When neither
    // is conclusive (common on karaoke re-recordings, which need not
    // envelope-correlate with the original master at all), aligning where
    // the music starts is far more reliable than the old end-together guess
    // (which desynced already-aligned songs).
    const candidates = estimateVideoOffsetCandidates(
      karaokeEnvelope,
      videoEnvelope,
      karaokeFineEnvelope,
      videoFineEnvelope,
    );

    // Melody probing wants the raw samples, not the envelope.
    const videoSamples = new Float64Array(Math.floor(videoPcm.length / 2));
    for (let i = 0; i < videoSamples.length; i++) {
      videoSamples[i] = videoPcm.readInt16LE(i * 2);
    }

    const choice = chooseVideoOffset(
      candidates,
      videoSamples,
      guideMelodyNotes,
    );
    let offsetMs: number | null;
    let method: string;
    if (choice !== null) {
      offsetMs = choice.offsetMs;
      method = choice.method;
    } else {
      offsetMs = estimateOnsetOffsetMs(karaokeEnvelope, videoEnvelope);
      method = "onset";
    }

    // Whatever picked the offset, check whether the video's tempo even
    // matches the karaoke's before trusting it as a constant - a
    // speed-shifted upload drifts steadily and the drift fit both proves it
    // and corrects the head offset for the stretch that will cancel it.
    let measurement: IntroSyncMeasurement | null = null;
    if (offsetMs !== null) {
      measurement = measureVideoDriftAround(
        karaokeEnvelope,
        videoEnvelope,
        karaokeFineEnvelope,
        videoFineEnvelope,
        offsetMs,
      ) ?? { offsetMs, videoStretchFactor: 1 };
    }

    console.info(
      `computeYoutubeIntroSync: video=${videoFilename} method=${method} offsetMs=${measurement === null ? "no confident estimate" : measurement.offsetMs} stretch=${measurement === null ? "-" : measurement.videoStretchFactor.toFixed(5)}`,
    );

    return measurement;
  } catch (e) {
    console.error(
      `computeYoutubeIntroSync failed for video ${videoFilename}: ${e}`,
    );
    return null;
  }
}

// Rescales the downloaded MV's video timestamps by stretchFactor (>1 slows
// it down) so its tempo matches the karaoke track - a copy-codec -itsscale
// remux, no re-encode. Runs before compose, so the usual trim/pad logic
// then operates on an already-tempo-matched video. The MV's own audio
// track is dropped here: intro-sync (the only consumer) has already read
// it, scaling its timestamps without resampling would corrupt it, and the
// composite's audio is the JOYSOUND ogg anyway.
function stretchJoysoundVideoPromise(
  songId: string,
  tempFilename: string,
  stretchFactor: number,
  ffmpegLogFilename: string,
): Promise<number> {
  const stretchedFilename = `${tempFilename}.stretched`;

  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-itsscale",
      stretchFactor.toFixed(6),
      "-i",
      tempFilename,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      "-y",
      stretchedFilename,
    ];

    const onExit = (code: number, signal: number) => {
      if (code === 0) {
        fs.unlinkSync(tempFilename);
        fs.renameSync(stretchedFilename, tempFilename);

        resolve(code);
      } else {
        console.error(
          `Error stretching Joysound video with ID ${songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      songId,
      ffmpegArgs,
      ffmpegLogFilename,
      null,
      onExit,
      null,
    );
  });
}

function composeJoysoundVideoPromise(
  songId: string,
  telopBuffer: Buffer,
  oggBuffer: Buffer,
  tempFilename: string,
  videoFilename: string,
  ffmpegLogFilename: string,
  // Signed video-vs-karaoke offset (only meaningful when tempFilename is a
  // downloaded YouTube video). Positive: the video has that much extra head
  // material - trim it off here with -ss so the visuals aren't out of sync
  // with the karaoke audio track. Negative: the karaoke track has extra head
  // material instead; the caller delays the video afterwards via
  // padJoysoundVideoPromise, so here we just play from the top. Null: no
  // confident measurement (JOYSOUND default video, or all detection failed).
  introOffsetMs: number | null = null,
): Promise<JoysoundVideoData> {
  return new Promise((resolve, reject) => {
    let videoPlaytime = 0;

    // The video comes from the MV (input 0) and the audio from the JOYSOUND
    // ogg on stdin (input 1) - always map both explicitly. The MV now carries
    // its own audio track (the "-f bv+ba/b" fetch that intro-sync reads), so
    // ffmpeg's default stream selection would have two audio streams to
    // choose between; it happens to prefer the ogg for having more channels
    // (3.0 vs stereo), but silently depending on that would be one codec
    // change away from compositing the MV's vocals over the karaoke.
    const streamMapArgs = ["-map", "0:v:0", "-map", "1:a:0"];

    // With a measured offset we align the heads and play the video through
    // exactly once, capped at the song length: the MV runs its full course -
    // including its outro - and the player holds the last frame for whatever
    // karaoke tail it doesn't cover. Looping instead would jarringly restart
    // the MV over the final seconds. Without a measurement we can't trust the
    // head alignment, so we keep the legacy loop-to-fill (a possibly-short
    // default video shouldn't freeze on one frame for the whole song).
    const ffmpegArgs =
      introOffsetMs !== null
        ? [
            ...(introOffsetMs > 0
              ? ["-ss", (introOffsetMs / 1000).toFixed(2)]
              : []),
            "-i",
            tempFilename,
            "-i",
            "-",
            ...streamMapArgs,
            "-c",
            "copy",
            "-t",
            `${getJoysoundOggPlaytime(oggBuffer)}ms`,
            "-movflags",
            "faststart",
            "-f",
            "mp4",
            videoFilename,
          ]
        : [
            "-stream_loop",
            "-1",
            "-i",
            tempFilename,
            "-i",
            "-",
            ...streamMapArgs,
            "-c",
            "copy",
            "-shortest",
            "-movflags",
            "faststart",
            "-f",
            "mp4",
            videoFilename,
          ];

    const onStderrData = (ffmpegData: Buffer) => {
      const ffmpegLog = ffmpegData.toString();

      const durationMatchData = ffmpegLog.match(
        /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/,
      );

      // XXX: We assume that the video duration always comes first
      if (durationMatchData && videoPlaytime === 0) {
        videoPlaytime += parseInt(durationMatchData[1], 10) * 3600;
        videoPlaytime += parseInt(durationMatchData[2], 10) * 60;
        videoPlaytime += parseInt(durationMatchData[3], 10);
        videoPlaytime =
          videoPlaytime * 1000 + parseInt(durationMatchData[4], 10) * 10;
      }
    };

    const onExit = (code: number, signal: number) => {
      fs.unlinkSync(tempFilename);

      if (code === 0) {
        const metadata: JoysoundVideoData = {
          songDuration:
            getSongDuration(telopBuffer.buffer as ArrayBuffer) * 1000,
          songPlaytime: getJoysoundOggPlaytime(oggBuffer),
          songId,
          oggBuffer,
          videoPlaytime,
        };

        resolve(metadata);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      songId,
      ffmpegArgs,
      ffmpegLogFilename,
      onStderrData,
      onExit,
      oggBuffer,
    );
  });
}

function padJoysoundVideoPromise(
  data: JoysoundVideoData,
  videoFilename: string,
  ffmpegLogFilename: string,
  // When set, front-pad the video by exactly this many ms (a measured
  // karaoke-has-extra-head-material delay from computeYoutubeIntroSync)
  // instead of the legacy heuristic of assuming the video and song should
  // end together.
  overridePadMs: number | null = null,
): Promise<number> {
  const videoBaseFilename = videoFilename.substr(0, videoFilename.length - 4);

  const videoNoSoundFilename = videoBaseFilename + "-no-sound.mp4";
  const videoPadFrameFilename = videoBaseFilename + "-pad-1f.mp4";
  const videoPadFilename = videoBaseFilename + "-pad.mp4";
  const videoConcatFilename = videoBaseFilename + "-concat.mp4";
  const videoTempFilename = videoBaseFilename + "-temp.mp4";
  const videoOutFilename = videoBaseFilename + "-out.mp4";
  const videoListFilename = videoBaseFilename + "-list.txt";

  return new Promise<number>((resolve, reject) => {
    const ffmpegArgs = [
      "-i",
      videoFilename,
      "-c",
      "copy",
      "-an",
      "-y",
      videoNoSoundFilename,
    ];

    const onExit = (code: number, signal: number) => {
      if (code === 0) {
        resolve(code);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      data.songId,
      ffmpegArgs,
      ffmpegLogFilename,
      null,
      onExit,
      null,
    );
  })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const ffmpegArgs = [
          "-i",
          videoNoSoundFilename,
          "-frames:v",
          "1",
          "-c:v",
          "copy",
          "-an",
          "-y",
          videoPadFrameFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const offset =
          overridePadMs !== null
            ? overridePadMs
            : Math.max(data.songPlaytime - data.videoPlaytime, 0);

        const ffmpegArgs = [
          "-stream_loop",
          "-1",
          "-i",
          videoPadFrameFilename,
          "-c",
          "copy",
          "-t",
          `${offset}ms`,
          "-y",
          videoPadFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        let listFile = "";

        listFile += `file '${videoPadFilename.replace(/\\/g, "/")}'`;
        listFile += "\n";
        listFile += `file '${videoNoSoundFilename.replace(/\\/g, "/")}'`;

        fs.writeFileSync(videoListFilename, listFile);

        const ffmpegArgs = [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          videoListFilename,
          "-c",
          "copy",
          "-y",
          videoConcatFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const ffmpegArgs = [
          "-i",
          videoFilename,
          "-i",
          videoConcatFilename,
          "-map",
          "0:a",
          "-map",
          "1:v",
          "-c",
          "copy",
          // With a measured pad the video usually doesn't span the whole
          // song - cap at the song length instead of truncating the audio
          // to the video (-shortest); the player holds the last frame for
          // whatever the video doesn't cover.
          ...(overridePadMs !== null
            ? ["-t", `${data.songPlaytime}ms`]
            : ["-shortest"]),
          "-y",
          videoOutFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            fs.renameSync(videoFilename, videoTempFilename);
            fs.renameSync(videoOutFilename, videoFilename);

            fs.unlinkSync(videoNoSoundFilename);
            fs.unlinkSync(videoPadFrameFilename);
            fs.unlinkSync(videoPadFilename);
            fs.unlinkSync(videoTempFilename);
            fs.unlinkSync(videoConcatFilename);
            fs.unlinkSync(videoListFilename);

            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    });
}

export function downloadJoysoundData(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  joysoundApi: JoysoundAPI,
  queueItem: JoysoundQueueItem,
  pushToHead: boolean,
  pushSongToQueue: (
    queueItem: JoysoundQueueItem,
    pushToHead: boolean,
  ) => QueueSongResult,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const songId = queueItem.songId;

  // Older queue items (and older remocon clients) don't carry the flag;
  // treat anything but an explicit false as enabled.
  const syncEnabled = queueItem.youtubeVideoSyncEnabled !== false;

  // The sync flag changes what ends up in the composited file, so an
  // unsynced composite must not be served from (or poison) the synced cache
  // entry, and vice versa.
  const videoFilenameSuffix = queueItem.youtubeVideoId
    ? `${queueItem.youtubeVideoId}${syncEnabled ? "" : "-nosync"}`
    : "default";

  const filenamePrefix = `joysound-${songId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const telopFilename = `${writeBasePath}.joy_02`;
  const videoFilename = `${writeBasePath}-${videoFilenameSuffix}.mp4`;
  const ffmpegLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  // A pipeline for this exact song+video is already in flight (its
  // download-queue entry lives until the song is pushed to the queue) - it
  // will land the song itself, so a repeat press is a no-op. This must be
  // checked before the composite-cache check below: during the late pipeline
  // stages (compose/pad) the composite file already exists on disk in a
  // half-written state, and serving it would push the song twice.
  if (
    downloadQueue.some(
      (item) =>
        item.downloadType === 0 &&
        item.songId === songId &&
        item.suffix === queueItem.youtubeVideoId,
    )
  ) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  }

  if (fs.existsSync(videoFilename)) {
    console.info(`${videoFilename} already exists, not redownloading`);

    if (fs.existsSync(telopFilename)) {
      const telopBuffer = fs.readFileSync(telopFilename);

      queueItem = {
        ...queueItem,
        playtime: getSongDuration(telopBuffer.buffer),
      };

      // The composited video's audio stream is the ogg (copied), so it can
      // seed guide-melody extraction when the melody cache is missing (e.g.
      // songs downloaded before this feature existed).
      ensureJoysoundGuideMelody(songId, { mediaFilename: videoFilename });

      pushSongToQueue(queueItem, pushToHead);
      return;
    } else {
      console.error(
        `${videoFilename} already exists, but ${telopFilename} does not.`,
      );

      fs.unlinkSync(videoFilename);
    }
  }

  if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 0,
    userIdentity,
    songId,
    suffix: queueItem.youtubeVideoId,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  const songDataPromise = joysoundApi.getSongRawData(songId);

  let videoDataPromise;

  if (queueItem.youtubeVideoId) {
    // YouTube intermittently rejects a format or throttles a request; one
    // retry rescues most of those before the catch below gives up and
    // silently falls back to the song's default video. But a rate-limit /
    // bot-wall answers the same way however often we ask, so retrying it
    // can't succeed - it just spends more of the quota that got us walled.
    // Back off briefly first: the old retry fired instantly, which hammered
    // YouTube hardest exactly when it was already pushing back.
    videoDataPromise = downloadJoysoundYoutubeVideoPromise(
      songId,
      queueItem.youtubeVideoId,
      downloadQueue,
      downloadQueueItem,
      tempFilename,
    ).catch((e: YoutubeDownloadFailure) => {
      if (e && e.rateLimited) {
        console.error(
          `Joysound YouTube video download for ${queueItem.youtubeVideoId} was rate-limited/bot-walled; not retrying: ${e}`,
        );

        throw e;
      }

      console.error(
        `Joysound YouTube video download failed for ${queueItem.youtubeVideoId}, retrying once after ${YOUTUBE_RETRY_BACKOFF_MS}ms: ${e}`,
      );

      return new Promise((resolve) =>
        setTimeout(resolve, YOUTUBE_RETRY_BACKOFF_MS),
      ).then(() =>
        downloadJoysoundYoutubeVideoPromise(
          songId,
          queueItem.youtubeVideoId!,
          downloadQueue,
          downloadQueueItem,
          tempFilename,
        ),
      );
    });
  } else {
    videoDataPromise = joysoundApi.getMovieUrls(songId).then((data) => {
      const videoUrl = data.movie.mov1;

      return downloadJoysoundVideoPromise(
        songId,
        videoUrl,
        downloadQueue,
        downloadQueueItem,
        tempFilename,
        ffmpegLogFilename,
      );
    });
  }

  // Video-vs-karaoke sync measurement (head offset + tempo stretch); null
  // when no confident estimate (see computeYoutubeIntroSync). Captured for
  // the stretch step and the post-compose pad decision. Chained after the
  // video download because it reads the MV's audio straight out of the file
  // that download produced - no second trip to YouTube.
  let measuredIntroSync: IntroSyncMeasurement | null = null;

  const introSyncPromise: Promise<IntroSyncMeasurement | null> =
    queueItem.youtubeVideoId && syncEnabled
      ? Promise.all([videoDataPromise, songDataPromise]).then(
          async ([, raw]) => {
            const oggBuffer = decodeJoysoundBase64Field(raw.ogg);
            // The guide melody powers intro-sync's melody-salience candidate
            // selection (and the piano roll needs it anyway): kick off (or
            // reuse) the extraction and wait for its notes.
            ensureJoysoundGuideMelody(songId, { oggBuffer });
            const scoringData = await getJoysoundScoringData(songId);
            return computeYoutubeIntroSync(
              oggBuffer,
              tempFilename,
              scoringData === null ? null : parseScoringData(scoringData),
            );
          },
        )
      : Promise.resolve(null);

  console.info(`Downloading Joysound video to ${videoFilename}`);

  Promise.all([videoDataPromise, songDataPromise, introSyncPromise])
    .then((values) => {
      const joysoundSongRawData = values[1];
      measuredIntroSync = values[2];

      const telopBuffer = decodeJoysoundBase64Field(joysoundSongRawData.telop);
      const oggBuffer = decodeJoysoundBase64Field(joysoundSongRawData.ogg);

      if (!fs.existsSync(telopFilename)) {
        fs.writeFileSync(telopFilename, telopBuffer);
      }

      ensureJoysoundGuideMelody(songId, { oggBuffer });

      // A speed-shifted MV gets its timestamps rescaled to the karaoke's
      // tempo first; the offset already accounts for the stretch.
      const stretchPromise =
        measuredIntroSync !== null && measuredIntroSync.videoStretchFactor !== 1
          ? stretchJoysoundVideoPromise(
              songId,
              tempFilename,
              measuredIntroSync.videoStretchFactor,
              ffmpegLogFilename,
            )
          : Promise.resolve(0);

      return stretchPromise.then(() =>
        composeJoysoundVideoPromise(
          songId,
          telopBuffer,
          oggBuffer,
          tempFilename,
          videoFilename,
          ffmpegLogFilename,
          measuredIntroSync === null ? null : measuredIntroSync.offsetMs,
        ),
      );
    })
    .then((data) => {
      queueItem = {
        ...queueItem,
        playtime: Math.floor(data.songPlaytime / 1000),
      };

      if (
        queueItem.youtubeVideoId &&
        measuredIntroSync !== null &&
        measuredIntroSync.offsetMs < 0
      ) {
        // The karaoke track has extra head material (e.g. a count-off, or a
        // longer intro than the original recording): delay the video by the
        // measured amount so its music lands with the karaoke's.
        return padJoysoundVideoPromise(
          data,
          videoFilename,
          ffmpegLogFilename,
          -measuredIntroSync.offsetMs,
        );
      }

      // Positive / null offsets need no post-compose step: compose already
      // trimmed the video head (-ss) or left the heads aligned, and holds the
      // last frame for any uncovered tail. The old "assume video and song end
      // together" pad used to fire here on a null measurement, but it blindly
      // shoved the whole video several seconds late (desyncing songs whose
      // heads were already aligned), so it's gone.
    })
    .then(() => {
      // The download-queue entry lives until the song actually lands in the
      // queue: it's what hasMaxSongsInQueue and the in-flight guard at the
      // top of this function consult, and removing it when the raw download
      // finished - with 30-60s of intro-sync + compositing still to go -
      // opened a window where a second press of the queue button wiped the
      // in-flight pipeline's temp files and double-queued the song.
      removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

      pushSongToQueue(queueItem, pushToHead);
    })
    .catch((error) => {
      console.error(
        `Failed to prepare video for song ${songId} (youtubeVideoId=${queueItem.youtubeVideoId}): ${error}`,
      );

      removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

      if (fs.existsSync(tempFilename)) {
        fs.unlinkSync(tempFilename);
      }

      // A custom YouTube background video is a nice-to-have - if fetching
      // or compositing it fails for any reason, don't leave the queue
      // request hanging forever. Fall back to the song's default video
      // instead of failing the whole queue attempt.
      if (queueItem.youtubeVideoId) {
        console.info(
          `Falling back to the default Joysound video for song ${songId}`,
        );

        downloadJoysoundData(
          downloadQueue,
          userIdentity,
          joysoundApi,
          { ...queueItem, youtubeVideoId: null },
          pushToHead,
          pushSongToQueue,
        );
      }
    });
}

export function downloadYoutubeVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  captionCode: string | null,
  onComplete: () => any,
): void {
  if (captionCode !== null && !captionCodeRe.test(captionCode)) {
    console.error(
      `Error downloading Youtube Video. ${captionCode} is not a valid caption code`,
    );
    return;
  }

  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filenamePrefix = `yt-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const vttFilename = `${writeBasePath}.vtt`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  if (isVideoCurrentlyDownloading(tempFilename, downloadQueue, 1, videoId)) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  } else if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 1,
    userIdentity,
    songId: videoId,
    suffix: null,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  console.info(`Downloading YouTube video to ${videoFilename}`);

  const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename);

  const captionArgs = captionCode
    ? ["--write-subs", "--sub-langs", captionCode]
    : [];

  const ytdlp = spawn(
    resourcePaths.ytdlp,
    [
      ...youtubeCookieArgs(),
      ...youtubeJsRuntimeArgs(),
      ...captionArgs,
      "-S",
      "res:720,ext:mp4:m4a",
      "--recode",
      "mp4",
      "-N",
      "4",
      "--ffmpeg-location",
      resourcePaths.ffmpeg,
      "-o",
      `${videoFilename}`,
      "--",
      videoId,
    ],
    { env: youtubeSpawnEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );

  invariant(ytdlp.stdout);
  invariant(ytdlp.stderr);

  ytdlp.stdout.pipe(process.stdout);
  ytdlp.stdout.pipe(ytdlpLogStream);
  ytdlp.stderr.pipe(process.stderr);
  ytdlp.stderr.pipe(ytdlpLogStream);

  ytdlp.stdout.on("data", (data) => {
    handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
  });

  ytdlp.on("exit", (code, signal) => {
    removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

    fs.unlinkSync(tempFilename);

    if (code !== 0) {
      console.error(
        `Error downloading Youtube Video with ID ${videoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
      );
      return;
    }

    if (captionCode) {
      try {
        fs.renameSync(`${writeBasePath}.${captionCode}.vtt`, vttFilename);
      } catch (fsError) {
        console.error(
          `Error trying to rename caption file ${writeBasePath}.${captionCode}.vtt to ${writeBasePath}.vtt: ${fsError}`,
        );
      }
    }

    onComplete();
  });
}

export function downloadNicoVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  onComplete: () => any,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filenamePrefix = `nico-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  if (isVideoCurrentlyDownloading(tempFilename, downloadQueue, 2, videoId)) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  } else if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 2,
    userIdentity,
    songId: videoId,
    suffix: null,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  console.info(`Downloading Niconico video to ${videoFilename}`);

  const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename);

  const env = { ...process.env };
  // Don't need a proxy to download from Niconico
  delete process.env.http_proxy;

  const ytdlp = spawn(
    resourcePaths.ytdlp,
    [
      "-N",
      "4",
      "-o",
      `${videoFilename}`,
      "--",
      `https://www.nicovideo.jp/watch/${videoId}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  invariant(ytdlp.stdout);
  invariant(ytdlp.stderr);

  ytdlp.stdout.pipe(process.stdout);
  ytdlp.stdout.pipe(ytdlpLogStream);
  ytdlp.stderr.pipe(process.stderr);
  ytdlp.stderr.pipe(ytdlpLogStream);

  ytdlp.stdout.on("data", (data) => {
    handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
  });

  ytdlp.on("exit", (code, signal) => {
    removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

    fs.unlinkSync(tempFilename);

    if (code === 0) {
      onComplete();
    } else {
      console.error(
        `Error downloading Niconico Video with ID ${videoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
      );
    }
  });
}
