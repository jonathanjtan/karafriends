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
import { ensureJoysoundGuideMelody } from "../main/joysoundMelody";

import { decodeJoysoundBase64Field, getSongDuration } from "./joysoundParser";

export const TEMP_FOLDER: string = `${app.getPath("temp")}/karafriends_tmp`;
const captionCodeRe: RegExp = new RegExp(/^[a-z]{2}$/);

const extraResourcesPath: string =
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
        // computeYoutubeIntroOffsetMs needs the MV's audio to measure the
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
// The estimate runs in two stages. A coarse (100ms-envelope) scan of every
// lag at every anchor collects *all* local correlation peaks as candidate
// offsets - not just each anchor's best match. Each candidate is then
// refined and re-scored on a fine (10ms) envelope, averaged across every
// anchor, and the best-validated candidate wins. The two stages exist
// because the coarse scan alone gets repetitive songs wrong in two
// compounding ways (this was the Shintakarajima bug): (1) a true offset
// that falls between the 100ms lag grid points loses enough envelope
// correlation to score *below* a phrase-aliased ghost offset (one riff
// repetition away) that happens to sit on the grid, and (2) trusting each
// anchor's single best match means one confident aliased anchor can win the
// consensus outright. Scoring every candidate at every anchor at fine
// resolution disambiguates both: the true offset scores well everywhere,
// while a phrase alias only scores well inside the repeated section.
//
// A positive offset means the MV has extra head material: trim it off with
// -ss when compositing. A negative offset means the karaoke track has extra
// head material: delay the video by front-padding it with its frozen first
// frame (padJoysoundVideoPromise). If no confident consensus emerges we
// return null and leave the legacy duration-difference pad heuristic to do
// its best.
//
// Known limitation: a single offset can't correct tempo drift (karaoke
// re-recordings sometimes run fractions of a percent slower/faster than the
// original master), so we anchor the head of the song - where a visual
// mismatch throws the singer off the most - and accept the tail drifting by
// up to a second or two.

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
// Candidate handling for the two-stage estimate. Coarse local peaks within
// MERGE_MS of a stronger one are the same peak sampled off-grid, not a
// separate candidate. The refine radius only needs to cover coarse grid
// quantization (half a coarse window) plus a little envelope smear - the
// nearest distinct alias is a full riff repetition (seconds) away. The
// candidate cap bounds main-process CPU on pathologically repetitive tracks;
// the worst observed true-candidate coarse rank is 20 (Shintakarajima).
// MIN_MEAN_SCORE gates how well the winner must correlate on average across
// all anchors (observed true offsets: 0.57-0.77), and MIN_RUNNER_UP_MARGIN
// declares the measurement inconclusive when a well-separated second
// candidate scores nearly as well (observed true margins: 0.11-0.21).
const INTRO_SYNC_CANDIDATE_MERGE_MS = 300;
const INTRO_SYNC_REFINE_RADIUS_MS = 250;
const INTRO_SYNC_MAX_CANDIDATES = 64;
const INTRO_SYNC_MIN_MEAN_SCORE = 0.5;
const INTRO_SYNC_RUNNER_UP_SEPARATION_MS = 1500;
const INTRO_SYNC_MIN_RUNNER_UP_MARGIN = 0.05;
// Tempo drift between the two recordings makes a single offset a
// compromise; after validation, the winner is nudged to best fit the
// head-most anchors, where a visual mismatch throws the singer off most.
const INTRO_SYNC_HEAD_REFINE_ANCHORS = 2;
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

// Mean fine-envelope correlation of a fixed candidate offset across the
// anchor set - the validation score of the two-stage estimate. -Infinity
// when fewer than half the anchors fit inside both tracks at this offset
// (a candidate shouldn't win by being scored on a cherry-picked remnant).
function meanAnchorScoreAt(
  karaokeFineEnvelope: number[],
  videoFineEnvelope: number[],
  anchorsMs: number[],
  offsetMs: number,
): number {
  const windowMs = INTRO_SYNC_FINE_WINDOW_MS;
  const referenceWindows = (INTRO_SYNC_REFERENCE_SEC * 1000) / windowMs;
  const lagWindows = Math.round(offsetMs / windowMs);

  let sum = 0;
  let count = 0;
  for (const anchorMs of anchorsMs) {
    const anchorWindows = anchorMs / windowMs;
    const videoStart = anchorWindows + lagWindows;
    if (
      anchorWindows + referenceWindows > karaokeFineEnvelope.length ||
      videoStart < 0 ||
      videoStart + referenceWindows > videoFineEnvelope.length
    ) {
      continue;
    }
    sum += pearsonCorrelationAt(
      karaokeFineEnvelope,
      anchorWindows,
      videoFineEnvelope,
      videoStart,
      referenceWindows,
    );
    count++;
  }

  return count < Math.ceil(anchorsMs.length / 2) ? -Infinity : sum / count;
}

// Two-stage offset estimate (see the block comment above the constants).
// Returns the video-minus-karaoke offset in ms (positive: video has extra
// head material; negative: karaoke does), or null if no candidate validates
// confidently.
function estimateVideoOffsetMs(
  karaokeEnvelope: number[],
  videoEnvelope: number[],
  karaokeFineEnvelope: number[],
  videoFineEnvelope: number[],
): number | null {
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
    if (merged.length >= INTRO_SYNC_MAX_CANDIDATES) {
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

  // Stage 2: refine each candidate on the fine envelope (the coarse grid
  // quantizes offsets to 100ms, which is audible) and validate it by its
  // mean correlation across every anchor.
  const refined: OffsetCandidate[] = [];
  for (const candidate of merged) {
    let best: OffsetCandidate = {
      offsetMs: candidate.offsetMs,
      score: -Infinity,
    };
    for (
      let offsetMs = candidate.offsetMs - INTRO_SYNC_REFINE_RADIUS_MS;
      offsetMs <= candidate.offsetMs + INTRO_SYNC_REFINE_RADIUS_MS;
      offsetMs += INTRO_SYNC_FINE_WINDOW_MS
    ) {
      if (Math.abs(offsetMs) > INTRO_SYNC_MAX_OFFSET_MS) {
        continue;
      }
      const score = meanAnchorScoreAt(
        karaokeFineEnvelope,
        videoFineEnvelope,
        anchorsMs,
        offsetMs,
      );
      if (score > best.score) {
        best = { offsetMs, score };
      }
    }
    if (best.score > -Infinity) {
      refined.push(best);
    }
  }
  refined.sort((a, b) => b.score - a.score);

  const winner = refined[0];
  if (!winner || winner.score < INTRO_SYNC_MIN_MEAN_SCORE) {
    return null;
  }
  const runnerUp = refined.find(
    (c) =>
      Math.abs(c.offsetMs - winner.offsetMs) >
      INTRO_SYNC_RUNNER_UP_SEPARATION_MS,
  );
  if (
    runnerUp &&
    winner.score - runnerUp.score < INTRO_SYNC_MIN_RUNNER_UP_MARGIN
  ) {
    return null;
  }

  // Head polish: under tempo drift the all-anchor mean is a compromise, but
  // the head is where a visual mismatch throws the singer off most. Nudge
  // the validated winner to best fit the head-most anchors.
  const headAnchorsMs = anchorsMs.slice(0, INTRO_SYNC_HEAD_REFINE_ANCHORS);
  let polished: OffsetCandidate = {
    offsetMs: winner.offsetMs,
    score: meanAnchorScoreAt(
      karaokeFineEnvelope,
      videoFineEnvelope,
      headAnchorsMs,
      winner.offsetMs,
    ),
  };
  for (
    let offsetMs = winner.offsetMs - INTRO_SYNC_REFINE_RADIUS_MS;
    offsetMs <= winner.offsetMs + INTRO_SYNC_REFINE_RADIUS_MS;
    offsetMs += INTRO_SYNC_FINE_WINDOW_MS
  ) {
    if (Math.abs(offsetMs) > INTRO_SYNC_MAX_OFFSET_MS) {
      continue;
    }
    const score = meanAnchorScoreAt(
      karaokeFineEnvelope,
      videoFineEnvelope,
      headAnchorsMs,
      offsetMs,
    );
    if (score > polished.score) {
      polished = { offsetMs, score };
    }
  }

  return polished.offsetMs;
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

// Estimates the signed offset (ms) between a YouTube video's audio and the
// Joysound karaoke track. Positive: the video has extra head material that
// should be trimmed. Negative: the karaoke track has extra head material,
// so the video should be delayed. Null: no confident estimate.
//
// videoFilename is the MV yt-dlp already downloaded (audio included, see the
// "-f bv+ba/b" fetch): reading its audio off disk keeps this to zero extra
// YouTube requests. It used to re-download the same video's audio with a
// second "-f ba" extraction, which doubled our request volume per song and
// helped earn us HTTP 429s.
export async function computeYoutubeIntroOffsetMs(
  oggBuffer: Buffer,
  videoFilename: string,
): Promise<number | null> {
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

    // Cross-correlation is the primary method: it can see through a loud
    // non-musical intro (spoken bit, ambient) that would fool onset
    // detection. But it's often inconclusive on karaoke re-recordings, and
    // when it is, aligning where the music starts is far more reliable than
    // the old end-together guess (which desynced already-aligned songs).
    let offsetMs = estimateVideoOffsetMs(
      karaokeEnvelope,
      videoEnvelope,
      karaokeFineEnvelope,
      videoFineEnvelope,
    );
    let method = "correlation";
    if (offsetMs === null) {
      offsetMs = estimateOnsetOffsetMs(karaokeEnvelope, videoEnvelope);
      method = "onset";
    }

    console.info(
      `computeYoutubeIntroOffsetMs: video=${videoFilename} method=${method} offsetMs=${offsetMs === null ? "no confident estimate" : offsetMs}`,
    );

    return offsetMs;
  } catch (e) {
    console.error(
      `computeYoutubeIntroOffsetMs failed for video ${videoFilename}: ${e}`,
    );
    return null;
  }
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
  // karaoke-has-extra-head-material delay from computeYoutubeIntroOffsetMs)
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

  // Signed video-vs-karaoke offset; null when no confident estimate (see
  // computeYoutubeIntroOffsetMs). Captured for the post-compose pad decision.
  // Chained after the video download because it reads the MV's audio straight
  // out of the file that download produced - no second trip to YouTube.
  let measuredIntroOffsetMs: number | null = null;

  const introOffsetPromise: Promise<number | null> =
    queueItem.youtubeVideoId && syncEnabled
      ? Promise.all([videoDataPromise, songDataPromise]).then(([, raw]) =>
          computeYoutubeIntroOffsetMs(
            decodeJoysoundBase64Field(raw.ogg),
            tempFilename,
          ),
        )
      : Promise.resolve(null);

  console.info(`Downloading Joysound video to ${videoFilename}`);

  Promise.all([videoDataPromise, songDataPromise, introOffsetPromise])
    .then((values) => {
      const joysoundSongRawData = values[1];
      measuredIntroOffsetMs = values[2];

      const telopBuffer = decodeJoysoundBase64Field(joysoundSongRawData.telop);
      const oggBuffer = decodeJoysoundBase64Field(joysoundSongRawData.ogg);

      if (!fs.existsSync(telopFilename)) {
        fs.writeFileSync(telopFilename, telopBuffer);
      }

      ensureJoysoundGuideMelody(songId, { oggBuffer });

      return composeJoysoundVideoPromise(
        songId,
        telopBuffer,
        oggBuffer,
        tempFilename,
        videoFilename,
        ffmpegLogFilename,
        measuredIntroOffsetMs,
      );
    })
    .then((data) => {
      queueItem = {
        ...queueItem,
        playtime: Math.floor(data.songPlaytime / 1000),
      };

      if (
        queueItem.youtubeVideoId &&
        measuredIntroOffsetMs !== null &&
        measuredIntroOffsetMs < 0
      ) {
        // The karaoke track has extra head material (e.g. a count-off, or a
        // longer intro than the original recording): delay the video by the
        // measured amount so its music lands with the karaoke's.
        return padJoysoundVideoPromise(
          data,
          videoFilename,
          ffmpegLogFilename,
          -measuredIntroOffsetMs,
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
