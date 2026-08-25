#!/usr/bin/node
import fetch from "node-fetch";
import sevenBin from "7zip-bin";
import fs from "fs";
import mv from "mv";
import os from "os";
import path from "path";
import process from "process";
import zlib from "zlib";
import { exec, execFile } from "child_process";

import { ensurePortraits } from "./getPortraits.mjs";

const pathTo7zip = sevenBin.path7za;
const buildResourcesDir = `${process.cwd()}/buildResources`;
const extraResourcesDir = `${process.cwd()}/extraResources`;
const maxMsToWaitForExtraction = 20000;

// ffmpeg for macOS must match the *target* arch, which isn't necessarily the
// build host's: CI builds both the arm64 and x86_64 macOS releases on the same
// (arm64) runner, distinguished only by the cargo target in CARGO_ARGS. Prefer
// that signal; fall back to the host arch for local dev. We source a native
// arm64 build from eugeneware/ffmpeg-static (GitHub-hosted, versioned, gzipped
// single binary), because evermeet.cx only ships x86_64, which fails with "bad
// CPU type" on Apple Silicon without Rosetta.
function macTargetArch() {
  const cargoArgs = process.env.CARGO_ARGS || "";
  if (cargoArgs.includes("aarch64-apple-darwin")) return "arm64";
  if (cargoArgs.includes("x86_64-apple-darwin")) return "x86_64";
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

const FFMPEG_STATIC_TAG = "b6.1.1";
const macFfmpegUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}/ffmpeg-darwin-${
  macTargetArch() === "arm64" ? "arm64" : "x64"
}.gz`;

// Gunzip a *.gz single-file download straight to its destination.
function gunzipFile(srcPath, destPath, onDone) {
  const src = fs.createReadStream(srcPath);
  const dest = fs.createWriteStream(destPath);
  src
    .pipe(zlib.createGunzip())
    .pipe(dest)
    .on("finish", onDone)
    .on("error", (err) => {
      throw err;
    });
}

async function fetchWithRetries(url, retries) {
  return fetch(url).then((res) => {
    if (res.ok) {
      return res;
    }
    if (retries > 0) {
      return fetchWithRetries(url, retries - 1);
    }
    throw new Error(res.status);
  });
}

async function downloadFile(url, path) {
  const res = await fetchWithRetries(url, 3);
  const fileStream = fs.createWriteStream(path);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

const winTasks = {
  ytdlpUrl:
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
  ytdlpPath: `${extraResourcesDir}/ytdlp/yt-dlp.exe`,
  doChecks: () => [
    fs.existsSync(`${extraResourcesDir}/ytdlp/yt-dlp.exe`),
    fs.existsSync(`${extraResourcesDir}/ffmpeg/win/ffmpeg.exe`),
    fs.existsSync(`${buildResourcesDir}/asio/asiosdk/common/asio.h`),
  ],
  prepareDirs: async (tmpDir) =>
    Promise.all([
      fs.mkdir(`${tmpDir}/ffmpeg/win`, { recursive: true }, () => null),
      fs.mkdir(`${extraResourcesDir}/ytdlp`, { recursive: true }, () => null),
      fs.mkdir(
        `${extraResourcesDir}/ffmpeg/win`,
        { recursive: true },
        () => null,
      ),
      fs.mkdir(`${tmpDir}/asio`, { recursive: true }, () => null),
      fs.mkdir(`${buildResourcesDir}/asio`, { recursive: true }, () => null),
    ]),
  getAssets: async (tmpDir) =>
    Promise.all([
      downloadFile(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
        `${extraResourcesDir}/ytdlp/yt-dlp.exe`,
      ),
      downloadFile(
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
        `${tmpDir}/ffmpeg/win/ffmpeg.7z`,
      ),
      downloadFile(
        "https://www.steinberg.net/asiosdk",
        `${tmpDir}/asio/asio.zip`,
      ),
    ]),
  extractAssets: async (tmpDir, hasFinishedExtracting) => {
    execFile(
      pathTo7zip,
      [
        "e",
        `${tmpDir}/ffmpeg/win/ffmpeg.7z`,
        "-y",
        `-o${tmpDir}/ffmpeg/win/contents`,
      ],
      (error, stdout, stderr) => {
        mv(
          `${tmpDir}/ffmpeg/win/contents/ffmpeg.exe`,
          `${extraResourcesDir}/ffmpeg/win/ffmpeg.exe`,
          (err) => {
            if (err) {
              console.error(error);
              throw err;
            }
            hasFinishedExtracting[0] = true;
          },
        );
      },
    );
    execFile(
      pathTo7zip,
      ["x", `${tmpDir}/asio/asio.zip`, "-y", `-o${buildResourcesDir}/asio`],
      (error, stdout, stderr) => {
        if (error) {
          console.error(error);
          throw error;
        }
        hasFinishedExtracting[1] = true;
      },
    );
  },
  setPermissions: () => null,
};

const macosTasks = {
  ytdlpUrl:
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
  ytdlpPath: `${extraResourcesDir}/ytdlp/yt-dlp_macos`,
  doChecks: () => [
    fs.existsSync(`${extraResourcesDir}/ytdlp/yt-dlp_macos`),
    fs.existsSync(`${extraResourcesDir}/ffmpeg/macos/ffmpeg`),
    fs.existsSync(buildResourcesDir),
  ],
  prepareDirs: async (tmpDir) =>
    Promise.all([
      fs.mkdir(`${tmpDir}/ffmpeg/macos`, { recursive: true }, () => null),
      fs.mkdir(`${extraResourcesDir}/ytdlp`, { recursive: true }, () => null),
      fs.mkdir(
        `${extraResourcesDir}/ffmpeg/macos`,
        { recursive: true },
        () => null,
      ),
      fs.mkdir(buildResourcesDir, () => null),
    ]),
  getAssets: async (tmpDir) =>
    Promise.all([
      downloadFile(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
        `${extraResourcesDir}/ytdlp/yt-dlp_macos`,
      ),
      downloadFile(macFfmpegUrl, `${tmpDir}/ffmpeg/macos/ffmpeg.gz`),
    ]),
  extractAssets: async (tmpDir, hasFinishedExtracting) => {
    gunzipFile(
      `${tmpDir}/ffmpeg/macos/ffmpeg.gz`,
      `${extraResourcesDir}/ffmpeg/macos/ffmpeg`,
      () => {
        hasFinishedExtracting[0] = true;
      },
    );
    hasFinishedExtracting[1] = true;
  },
  setPermissions: () => {
    fs.chmodSync(`${extraResourcesDir}/ffmpeg/macos/ffmpeg`, "755");
    fs.chmodSync(`${extraResourcesDir}/ytdlp/yt-dlp_macos`, "755");
  },
};

const linuxTasks = {
  ytdlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
  ytdlpPath: `${extraResourcesDir}/ytdlp/yt-dlp`,
  doChecks: () => [
    fs.existsSync(`${extraResourcesDir}/ytdlp/yt-dlp`),
    fs.existsSync(`${extraResourcesDir}/ffmpeg/linux/ffmpeg`),
    fs.existsSync(buildResourcesDir),
  ],
  prepareDirs: async (tmpDir) =>
    Promise.all([
      fs.mkdir(`${tmpDir}/ffmpeg/linux`, { recursive: true }, () => null),
      fs.mkdir(`${extraResourcesDir}/ytdlp`, { recursive: true }, () => null),
      fs.mkdir(
        `${extraResourcesDir}/ffmpeg/linux`,
        { recursive: true },
        () => null,
      ),
      fs.mkdir(buildResourcesDir, () => null),
    ]),
  getAssets: async (tmpDir) =>
    Promise.all([
      downloadFile(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
        `${extraResourcesDir}/ytdlp/yt-dlp`,
      ),
      downloadFile(
        "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
        `${tmpDir}/ffmpeg/linux/ffmpeg.tar.xz`,
      ),
    ]),
  extractAssets: async (tmpDir, hasFinishedExtracting) => {
    execFile(
      pathTo7zip,
      [
        "e",
        `${tmpDir}/ffmpeg/linux/ffmpeg.tar.xz`,
        "-y",
        `-o${tmpDir}/ffmpeg/linux/xz`,
      ],
      (error, stdout, stderr) => {
        execFile(
          pathTo7zip,
          [
            "e",
            `${tmpDir}/ffmpeg/linux/xz/ffmpeg.tar`,
            "-y",
            `-o${tmpDir}/ffmpeg/linux/contents`,
          ],
          (error, stdout, stderr) => {
            mv(
              `${tmpDir}/ffmpeg/linux/contents/ffmpeg`,
              `${extraResourcesDir}/ffmpeg/linux/ffmpeg`,
              (err) => {
                if (err) {
                  console.error(error);
                  throw err;
                }
                hasFinishedExtracting[0] = true;
              },
            );
          },
        );
      },
    );
    hasFinishedExtracting[1] = true;
  },
  setPermissions: () => {
    fs.chmodSync(`${extraResourcesDir}/ffmpeg/linux/ffmpeg`, "755");
    fs.chmodSync(`${extraResourcesDir}/ytdlp/yt-dlp`, "755");
  },
};

// yt-dlp goes stale fast: YouTube regularly changes its player in ways that
// break older releases (bot-check walls, signature/n-param solving), so
// unlike the stable ffmpeg/asio assets it must be refreshed to the latest
// release on every build rather than cached by the existence check below.
// (A bundled 2026.03.17 binary silently failed every YouTube MV download
// with "Sign in to confirm you're not a bot" until this was added.)
async function refreshYtdlp(tasks) {
  await fs.promises.mkdir(path.dirname(tasks.ytdlpPath), { recursive: true });
  await downloadFile(tasks.ytdlpUrl, tasks.ytdlpPath);
  if (process.platform !== "win32") {
    fs.chmodSync(tasks.ytdlpPath, "755");
  }
}

async function getExternalResources(tasks) {
  await ensurePortraits();
  await refreshYtdlp(tasks);
  if (tasks.doChecks().every((check) => check === true)) {
    return;
  }
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "karafriends_getExternalResources"),
  );
  await tasks.prepareDirs(tmpDir);
  await tasks.getAssets(tmpDir);

  let hasFinishedExtracting = [false, false];
  let msToWaitForExtraction = maxMsToWaitForExtraction;
  await tasks.extractAssets(tmpDir, hasFinishedExtracting);
  await new Promise(async () => {
    while (
      msToWaitForExtraction > 0 &&
      !hasFinishedExtracting.every((x) => x)
    ) {
      await new Promise((r) => setTimeout(r, 200));
      msToWaitForExtraction -= 200;
    }
    fs.rmdirSync(tmpDir, { recursive: true });
    if (!hasFinishedExtracting.every((x) => x)) {
      console.error(
        `Extracting resources did not complete after ${maxMsToWaitForExtraction} ms and was aborted!`,
      );
      process.exit(1);
    }
    if (!tasks.doChecks(tmpDir).every((check) => check === true)) {
      console.error("An external resource wasn't successfuly downloaded!");
      process.exit(1);
    }
    tasks.setPermissions();
    process.exit(0);
  });
}

const tasks =
  process.platform === "win32"
    ? winTasks
    : process.platform === "darwin"
      ? macosTasks
      : linuxTasks;

await getExternalResources(tasks);
