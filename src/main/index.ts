import "./winFileUrlFix";

import { fileURLToPath } from "url";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as nativeAudioUrl } from "url:../../native/index.node";
const nativeAudio = require(fileURLToPath(nativeAudioUrl)); // tslint:disable-line:no-var-requires

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://80cbda8ca4af42d9b95c60eb1f00566f@sentry.io/6728669",
  debug: true,
});

async function handleError(err: unknown) {
  console.error("Fatal error:", err);
  Sentry.captureException(err);
  await Sentry.close(10 * 1000);
  process.exit(1);
}

process.on("uncaughtException", handleError);
process.on("unhandledRejection", handleError);

// `_run-dev` runs under `concurrently --kill-others`, which SIGTERMs this
// process the instant the dev server is stopped. Node's default SIGTERM/
// SIGINT handling exits immediately without draining pending debounce
// timers, so any reading/ranking cache entries resolved in the last
// debounce window (or a whole in-flight primeRankings sweep) never reached
// disk — and got re-searched against DAM/JOYSOUND on the very next launch.
// Flush synchronously before exiting so restarts actually see prior work.
function flushCachesAndExit() {
  flushReadingCacheOnShutdown();
  flushRankingCacheOnShutdown();
  process.exit(0);
}
process.on("SIGINT", flushCachesAndExit);
process.on("SIGTERM", flushCachesAndExit);

import inspector from "inspector";

// Start a debug server if we don't have one already. If we already have one, this would throw.
if (inspector.url() === undefined) inspector.open();

import fs from "fs";
import path from "path";

import compression from "compression";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  IpcMainEvent,
  protocol,
} from "electron"; // tslint:disable-line:no-implicit-dependencies
import isDev from "electron-is-dev";
import express from "express";

import karafriendsConfig from "../common/config";
import { TEMP_FOLDER } from "./../common/videoDownloader";
import { MinseiAPI } from "./damApi";
import { applyGraphQLMiddleware, flushReadingCacheOnShutdown } from "./graphql";
import { JoysoundAPI } from "./joysoundApi";
import setupMdns from "./mdns";
import remoconReverseProxy from "./middleware/remoconReverseProxy";
import remoconServiceWorkerAllowed from "./middleware/remoconServiceWorkerAllowed";
import { applyPortraitsMiddleware } from "./portraits";
import { flushRankingCacheOnShutdown } from "./rankings";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as preloadUrl } from "url:../preload";

try {
  nativeAudio.allocConsole();
} catch (e) {
  console.error(e);
}

setupMdns();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "karafriends",
    privileges: {
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let rendererWindow: BrowserWindow | null;
// The sidebar, detached into its own window (renderer bundle loaded with
// ?panel=settings). Null whenever it isn't open.
let settingsPanelWindow: BrowserWindow | null = null;
// The join QR, likewise (?panel=qr), for parking on a second display.
let qrPanelWindow: BrowserWindow | null = null;

const rendererWebPreferences = {
  allowRunningInsecureContent: false,
  // An occluded/hidden window freezes requestAnimationFrame, which
  // strands BGM volume fades mid-flight (audio keeps playing at volume 0
  // and the fade-aware watchdog waits on the frozen fade forever).
  backgroundThrottling: false,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  preload: fileURLToPath(preloadUrl),
  sandbox: false,
  webSecurity: true,
};

function rendererUrl(query: string = ""): string {
  return isDev
    ? `http://localhost:${karafriendsConfig.devPort}/renderer/${query}`
    : `file://${path.join(__dirname, "..", "..", "build", "prod", "renderer", "index.html")}${query}`;
}

// Relay a bus message to every renderer window except the one that sent it.
// The big screen and the popped-out panel are separate processes; this is the
// only channel they share (see preload's `settingsPanel`).
function broadcastSettingsPanelMessage(
  sender: Electron.WebContents | null,
  message: unknown,
) {
  [rendererWindow, settingsPanelWindow].forEach((win) => {
    if (win && !win.isDestroyed() && win.webContents !== sender) {
      win.webContents.send("settings-panel-message", message);
    }
  });
}

function createSettingsPanelWindow() {
  if (settingsPanelWindow && !settingsPanelWindow.isDestroyed()) {
    settingsPanelWindow.show();
    settingsPanelWindow.focus();
    return;
  }

  settingsPanelWindow = new BrowserWindow({
    // Always framed, even in the fullscreen production build: this window
    // exists to be moved to a second display and closed again.
    frame: true,
    title: "karafriends — Settings",
    width: 420,
    height: 900,
    minWidth: 260,
    minHeight: 320,
    webPreferences: rendererWebPreferences,
  });

  settingsPanelWindow.loadURL(rendererUrl("?panel=settings"));

  settingsPanelWindow.on("closed", () => {
    settingsPanelWindow = null;
    // The big screen re-shows its docked sidebar when the panel goes away,
    // and stops publishing mic levels nobody is watching.
    broadcastSettingsPanelMessage(null, { type: "panelClosed" });
  });
}

function createQrPanelWindow() {
  if (qrPanelWindow && !qrPanelWindow.isDestroyed()) {
    qrPanelWindow.show();
    qrPanelWindow.focus();
    return;
  }

  qrPanelWindow = new BrowserWindow({
    // Framed even in the fullscreen production build: the point of this
    // window is to be dragged to a second display and left there.
    frame: true,
    title: "karafriends — Join",
    width: 480,
    height: 620,
    minWidth: 240,
    minHeight: 300,
    backgroundColor: "#ffffff",
    webPreferences: rendererWebPreferences,
  });

  qrPanelWindow.loadURL(rendererUrl("?panel=qr"));

  qrPanelWindow.on("closed", () => {
    qrPanelWindow = null;
  });
}

function createWindow() {
  rendererWindow = new BrowserWindow({
    frame: isDev,
    fullscreen: !isDev,
    webPreferences: rendererWebPreferences,
  });

  // Ignore CORS when fetching ipcasting HLS and when sending requests to remocon
  const session = rendererWindow.webContents.session;
  const ignoreCORSFilter = {
    urls: [
      "https://*.ipcasting.jp/*",
      `http://localhost:${karafriendsConfig.remoconPort}/*`, // TODO: Set CORS headers on the Express side and remove this
    ],
  };

  session.webRequest.onBeforeSendHeaders(
    ignoreCORSFilter,
    (details, callback) => {
      delete details.requestHeaders.Origin;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  session.webRequest.onHeadersReceived(
    ignoreCORSFilter,
    (details, callback) => {
      // Chrome is not happy if ACAO is set twice, which is what happens
      // when the Express static middleware is setting this one
      delete details.responseHeaders!["access-control-allow-origin"];
      details.responseHeaders!["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders: details.responseHeaders });
    },
  );

  if (karafriendsConfig.proxyEnable) {
    session.setProxy({
      proxyRules: `${karafriendsConfig.proxyHost}:${karafriendsConfig.proxyPort}`,
      proxyBypassRules: "<local>,192.168.0.0/16,172.16.0.0/12,10.0.0.0/8",
    });
    // Technically should await this promise
  }

  protocol.registerFileProtocol("karafriends", (request, callback) => {
    console.log(`Got protocol request: ${request.method} ${request.url}`);
    const url = request.url.substr(14 /* 'karafriends://'.length */);
    callback({ path: path.normalize(`${TEMP_FOLDER}/${url}`) });
  });

  const expressApp = express();

  expressApp.use(compression());

  applyGraphQLMiddleware(expressApp);

  applyPortraitsMiddleware(expressApp);

  expressApp.use(remoconServiceWorkerAllowed());

  // This middleware terminates the request/response cycle and should be applied last
  expressApp.use(remoconReverseProxy(karafriendsConfig.devPort));

  if (rendererWindow) rendererWindow.loadURL(rendererUrl());

  // A reloaded big screen has no idea the panel window is still open (it would
  // show its own docked copy of the settings and stop feeding the panel mic
  // levels). Main is the authority on which windows exist, so it re-announces.
  rendererWindow.webContents.on("did-finish-load", () => {
    if (settingsPanelWindow && !settingsPanelWindow.isDestroyed()) {
      broadcastSettingsPanelMessage(settingsPanelWindow.webContents, {
        type: "panelOpened",
      });
    }
  });

  ipcMain.on("open-settings-panel", () => createSettingsPanelWindow());

  ipcMain.on("close-settings-panel", () => {
    if (settingsPanelWindow && !settingsPanelWindow.isDestroyed()) {
      settingsPanelWindow.close();
    }
  });

  ipcMain.on("open-qr-panel", () => createQrPanelWindow());

  ipcMain.on("close-qr-panel", () => {
    if (qrPanelWindow && !qrPanelWindow.isDestroyed()) {
      qrPanelWindow.close();
    }
  });

  ipcMain.on("settings-panel-message", (event: IpcMainEvent, message) =>
    broadcastSettingsPanelMessage(event.sender, message),
  );

  ipcMain.on("config", (event: IpcMainEvent) => {
    console.log("Sending config over ipc");
    event.returnValue = karafriendsConfig;
  });

  // Save a PNG of the renderer window (the score card overlaid on the video)
  // to the app's data dir (score-cards/, beside config.yaml). The renderer
  // asks once per revealed card; keep this best-effort and never throw across
  // the IPC boundary, so a failed grab (window gone, disk full) can't take down
  // a scoring path.
  ipcMain.handle(
    "save-score-card",
    async (
      _event,
      meta: { songName: string; band: string; overall: number },
    ): Promise<string | null> => {
      if (!rendererWindow) return null;
      try {
        const image = await rendererWindow.webContents.capturePage();
        const dir = path.join(app.getPath("userData"), "score-cards");
        fs.mkdirSync(dir, { recursive: true });

        // Sortable timestamp + a filesystem-safe slug of the song, so a night
        // of songs lands in chronological order and stays recognizable.
        const stamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/:/g, "")
          .replace("T", "_");
        const slug =
          meta.songName.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40) || "song";
        const file = path.join(
          dir,
          `${stamp}_${slug}_${meta.band}_${meta.overall}.png`,
        );

        fs.writeFileSync(file, image.toPNG());
        console.log(`Saved score card to ${file}`);
        return file;
      } catch (err) {
        console.error("Failed to save score card screenshot:", err);
        return null;
      }
    },
  );

  // Append a batch of latency-probe sample lines to a per-day log under the
  // app's own data dir (next to config.yaml), so scoring calibration data can
  // be collected from the packaged app just by turning pitchProbeEnabled on --
  // no terminal or stdout capture needed (a Finder-launched .app has nowhere to
  // tee). userData rather than a temp dir so a night's captures survive an OS
  // temp sweep. The renderer only sends batches while the flag is on.
  // Best-effort: a failed write is logged and dropped, never thrown across the
  // boundary.
  ipcMain.on("append-probe-log", (_event, lines: string[]) => {
    if (!Array.isArray(lines) || lines.length === 0) return;
    try {
      const dir = path.join(app.getPath("userData"), "probe-logs");
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(
        path.join(dir, `probe-${day}.log`),
        lines.join("\n") + "\n",
      );
    } catch (err) {
      console.error("Failed to append probe log:", err);
    }
  });
}

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

// Covers app.quit()/Cmd+Q in addition to the SIGINT/SIGTERM handlers above,
// which only fire for a terminal-driven stop (e.g. `_run-dev`'s
// concurrently --kill-others).
app.on("before-quit", () => {
  flushReadingCacheOnShutdown();
  flushRankingCacheOnShutdown();
});

app.on("activate", () => {
  if (rendererWindow === null) {
    createWindow();
  }
});

function refreshRendererWindow() {
  // Reload whichever window has focus: the settings panel is a second
  // renderer window, and reloading the big screen out from under someone who
  // hit Cmd+R in the panel would interrupt the playing song.
  const target = BrowserWindow.getFocusedWindow() ?? rendererWindow;
  if (!target) return;
  if (
    dialog.showMessageBoxSync(target, {
      message: "Are you sure you want to reload this window?",
      buttons: ["Reload", "Cancel"],
    }) === 0
  ) {
    target.reload();
  }
}

app.on("browser-window-focus", () => {
  globalShortcut.register("CommandOrControl+R", refreshRendererWindow);
  globalShortcut.register("F5", refreshRendererWindow);
});

app.on("browser-window-blur", () => {
  globalShortcut.unregister("CommandOrControl+R");
  globalShortcut.unregister("F5");
});

app.on("login", (event, webContents, request, authInfo, callback) => {
  console.log(
    `login event received: authinfo=${authInfo} callback=${callback}`,
  );
  if (karafriendsConfig.proxyEnable) {
    const { proxyHost, proxyPort, proxyUser, proxyPass } = karafriendsConfig;
    console.log(`Time to login to ${proxyHost}:${proxyPort}`);
    callback(proxyUser, proxyPass);
    event.preventDefault();
  } else {
    // Well that's strange...
    console.log("Received login event even though proxy is not enabled?");
    if (rendererWindow) {
      dialog.showMessageBoxSync(rendererWindow, {
        message:
          "Received login event even though proxy is not enabled. Proceed with caution",
      });
    }
  }
});
