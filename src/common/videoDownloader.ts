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

    const env = { ...process.env };
    // Don't need a proxy to download from YouTube
    delete env.http_proxy;

    const ytdlp = spawn(
      resourcePaths.ytdlp,
      [
        ...youtubeCookieArgs(),
        "-S",
        "res:720,ext:mp4",
        "-f",
        "bv",
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
        reject(code);
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
// the karaoke audio against the MV's own audio and taking the consensus.
// Windows are sampled from *inside* the song rather than just its head,
// because the head is exactly where karaoke arrangements diverge most from
// the original (count-offs, re-arranged intros).
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
const INTRO_SYNC_STRONG_CONFIDENCE_THRESHOLD = 0.75;
const INTRO_SYNC_CLUSTER_TOLERANCE_MS = 1500;
const INTRO_SYNC_CLUSTER_MIN_TOTAL_SCORE = 1.0;
const INTRO_SYNC_FIRST_ANCHOR_SEC = 10;
const INTRO_SYNC_ANCHOR_STEP_SEC = 15;
const INTRO_SYNC_LAST_ANCHOR_SEC = 120;
const INTRO_SYNC_ENVELOPE_WINDOW_MS = 100;
const INTRO_SYNC_SAMPLE_RATE_HZ = 8000;
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

function downloadYoutubeAudioAttempt(youtubeVideoId: string): Promise<string> {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const outputFilename = `${TEMP_FOLDER}/introsync-${youtubeVideoId}.m4a`;

  if (fs.existsSync(outputFilename)) {
    fs.unlinkSync(outputFilename);
  }

  return new Promise((resolve, reject) => {
    // A failure here silently costs the song its video sync, so unlike most
    // spawns in this file the yt-dlp output is kept in a log file.
    const logFilename = `${TEMP_FOLDER}/yt-${youtubeVideoId}-introsync.log`;
    // Append for the same reason as the video download log: keep the failed
    // first attempt's output around for diagnosis.
    const logStream = fs.createWriteStream(logFilename, { flags: "a" });

    const env = { ...process.env };
    // Don't need a proxy to download from YouTube
    delete env.http_proxy;

    const ytdlp = spawn(
      resourcePaths.ytdlp,
      [
        ...youtubeCookieArgs(),
        "-f",
        "ba",
        "--ffmpeg-location",
        resourcePaths.ffmpeg,
        "-o",
        outputFilename,
        "--",
        youtubeVideoId,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    invariant(ytdlp.stdout);
    invariant(ytdlp.stderr);

    ytdlp.stdout.pipe(logStream);
    ytdlp.stderr.pipe(logStream);

    ytdlp.on("error", reject);
    ytdlp.on("exit", (code) => {
      if (code === 0 && fs.existsSync(outputFilename)) {
        resolve(outputFilename);
      } else {
        reject(
          new Error(
            `yt-dlp audio download exited with code ${code}, log=${logFilename}`,
          ),
        );
      }
    });
  });
}

function downloadYoutubeAudio(youtubeVideoId: string): Promise<string> {
  // YouTube intermittently rejects a format or throttles a request; one
  // retry rescues most of those without meaningfully delaying the download.
  return downloadYoutubeAudioAttempt(youtubeVideoId).catch((e) => {
    console.error(
      `Intro-sync audio download failed for ${youtubeVideoId}, retrying once: ${e}`,
    );
    return downloadYoutubeAudioAttempt(youtubeVideoId);
  });
}

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

interface AnchorMatch {
  anchorWindows: number;
  offsetMs: number;
  score: number;
}

// Cross-correlates INTRO_SYNC_REFERENCE_SEC-long windows of the karaoke
// envelope (taken at several anchor points) against the whole video
// envelope, then looks for a cluster of anchors that agree on the same
// video-minus-karaoke offset. Returns the consensus offset in ms (positive:
// video has extra head material; negative: karaoke does), or null if no
// confident consensus exists.
function estimateVideoOffsetMs(
  karaokeEnvelope: number[],
  videoEnvelope: number[],
): number | null {
  const windowMs = INTRO_SYNC_ENVELOPE_WINDOW_MS;
  const referenceWindows = (INTRO_SYNC_REFERENCE_SEC * 1000) / windowMs;

  const anchors: number[] = [];
  for (
    let anchorSec = INTRO_SYNC_FIRST_ANCHOR_SEC;
    anchorSec <= INTRO_SYNC_LAST_ANCHOR_SEC &&
    (anchorSec * 1000) / windowMs + referenceWindows <= karaokeEnvelope.length;
    anchorSec += INTRO_SYNC_ANCHOR_STEP_SEC
  ) {
    anchors.push((anchorSec * 1000) / windowMs);
  }
  // Very short track: fall back to matching what we have from the head.
  if (anchors.length === 0 && referenceWindows <= karaokeEnvelope.length) {
    anchors.push(0);
  }

  const matches: AnchorMatch[] = [];

  for (const anchorWindows of anchors) {
    let bestLagWindows = 0;
    let bestScore = -Infinity;

    for (let lag = 0; lag + referenceWindows <= videoEnvelope.length; lag++) {
      const score = pearsonCorrelationAt(
        karaokeEnvelope,
        anchorWindows,
        videoEnvelope,
        lag,
        referenceWindows,
      );

      if (score > bestScore) {
        bestScore = score;
        bestLagWindows = lag;
      }
    }

    const offsetMs = (bestLagWindows - anchorWindows) * windowMs;

    if (
      bestScore >= INTRO_SYNC_CONFIDENCE_THRESHOLD &&
      Math.abs(offsetMs) <= INTRO_SYNC_MAX_OFFSET_MS
    ) {
      matches.push({ anchorWindows, offsetMs, score: bestScore });
    }
  }

  // Pick the cluster of mutually-agreeing offsets with the highest total
  // score. Tolerance is loose enough to absorb slight tempo drift between
  // the two recordings across anchor points.
  let bestCluster: AnchorMatch[] = [];
  let bestClusterScore = 0;

  for (const seed of matches) {
    const cluster = matches.filter(
      (m) =>
        Math.abs(m.offsetMs - seed.offsetMs) <= INTRO_SYNC_CLUSTER_TOLERANCE_MS,
    );
    const clusterScore = cluster.reduce((acc, m) => acc + m.score, 0);

    if (clusterScore > bestClusterScore) {
      bestCluster = cluster;
      bestClusterScore = clusterScore;
    }
  }

  const isConfident =
    bestClusterScore >= INTRO_SYNC_CLUSTER_MIN_TOTAL_SCORE ||
    (bestCluster.length === 1 &&
      bestCluster[0].score >= INTRO_SYNC_STRONG_CONFIDENCE_THRESHOLD);

  if (!isConfident) {
    return null;
  }

  // Tempo drift makes the offset slide slowly over the song, so the anchor
  // closest to the head gives the best estimate for where sync matters most.
  const headMostMatch = bestCluster.reduce((best, m) =>
    m.anchorWindows < best.anchorWindows ? m : best,
  );

  return headMostMatch.offsetMs;
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
export async function computeYoutubeIntroOffsetMs(
  oggBuffer: Buffer,
  youtubeVideoId: string,
): Promise<number | null> {
  let audioFilename: string | null = null;

  try {
    audioFilename = await downloadYoutubeAudio(youtubeVideoId);

    const [videoPcm, karaokePcm] = await Promise.all([
      decodeToPcm(audioFilename, INTRO_SYNC_MAX_DECODE_SEC),
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

    // Cross-correlation is the primary method: it can see through a loud
    // non-musical intro (spoken bit, ambient) that would fool onset
    // detection. But it's often inconclusive on karaoke re-recordings, and
    // when it is, aligning where the music starts is far more reliable than
    // the old end-together guess (which desynced already-aligned songs).
    let offsetMs = estimateVideoOffsetMs(karaokeEnvelope, videoEnvelope);
    let method = "correlation";
    if (offsetMs === null) {
      offsetMs = estimateOnsetOffsetMs(karaokeEnvelope, videoEnvelope);
      method = "onset";
    }

    console.info(
      `computeYoutubeIntroOffsetMs: video=${youtubeVideoId} method=${method} offsetMs=${offsetMs === null ? "no confident estimate" : offsetMs}`,
    );

    return offsetMs;
  } catch (e) {
    console.error(
      `computeYoutubeIntroOffsetMs failed for video ${youtubeVideoId}: ${e}`,
    );
    return null;
  } finally {
    if (audioFilename && fs.existsSync(audioFilename)) {
      fs.unlinkSync(audioFilename);
    }
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
    // YouTube intermittently rejects a format or throttles a request (same
    // flakiness as the intro-sync audio fetch); one retry rescues most of
    // those before the catch below gives up and silently falls back to the
    // song's default video.
    videoDataPromise = downloadJoysoundYoutubeVideoPromise(
      songId,
      queueItem.youtubeVideoId,
      downloadQueue,
      downloadQueueItem,
      tempFilename,
    ).catch((e) => {
      console.error(
        `Joysound YouTube video download failed for ${queueItem.youtubeVideoId}, retrying once: ${e}`,
      );

      return downloadJoysoundYoutubeVideoPromise(
        songId,
        queueItem.youtubeVideoId!,
        downloadQueue,
        downloadQueueItem,
        tempFilename,
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
  // Chained after the video download so we don't hit YouTube with two
  // concurrent requests for the same video - that invites throttling, and a
  // failed audio fetch silently costs the song its sync.
  let measuredIntroOffsetMs: number | null = null;

  const introOffsetPromise: Promise<number | null> =
    queueItem.youtubeVideoId && syncEnabled
      ? Promise.all([videoDataPromise, songDataPromise]).then(([, raw]) =>
          computeYoutubeIntroOffsetMs(
            decodeJoysoundBase64Field(raw.ogg),
            queueItem.youtubeVideoId!,
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
    { stdio: ["ignore", "pipe", "pipe"] },
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
