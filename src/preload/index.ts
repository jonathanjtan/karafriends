import { fileURLToPath } from "url";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as nativeAudioUrl } from "url:../../native/index.node";
const nativeAudio = require(fileURLToPath(nativeAudioUrl)); // tslint:disable-line:no-var-requires

import { contextBridge, ipcRenderer } from "electron"; // tslint:disable-line:no-implicit-dependencies
import { memoize } from "lodash";

import { KarafriendsConfig } from "../common/config";
import ipAddresses from "../common/ipAddresses";

let inputDeviceCount = 0;
const inputDevices: { [deviceId: number]: any } = {};

let karafriendsConfig: KarafriendsConfig | null = null;

contextBridge.exposeInMainWorld("karafriends", {
  ipAddresses,
  karafriendsConfig: () => {
    if (karafriendsConfig === null) {
      console.log("Making sync request for configs");
      karafriendsConfig = ipcRenderer.sendSync("config");
    }

    return karafriendsConfig;
  },
  // Capture the current score card to the app's data dir (score-cards/).
  // Resolves to the saved path, or null if the grab failed (the main handler
  // swallows errors).
  saveScoreCard: (meta: {
    songName: string;
    band: string;
    overall: number;
  }): Promise<string | null> => ipcRenderer.invoke("save-score-card", meta),
  // Append latency-probe sample lines to the per-day log in the app data dir.
  // Fire and forget (send, not invoke) -- the caller batches, and a dropped
  // batch just costs a few samples of calibration data.
  appendProbeLog: (lines: string[]): void =>
    ipcRenderer.send("append-probe-log", lines),
  // The popped-out settings window and the big screen are two renderer
  // processes, so they can't share React state. `send`/`subscribe` are a
  // broadcast bus between them (main relays each message to the *other*
  // window): the big screen owns the mic hardware, the panel sends intents
  // and receives snapshots. See settingsPanelBus.ts for the message shapes.
  settingsPanel: {
    open: (): void => ipcRenderer.send("open-settings-panel"),
    close: (): void => ipcRenderer.send("close-settings-panel"),
    send: (message: unknown): void =>
      ipcRenderer.send("settings-panel-message", message),
    subscribe: (callback: (message: unknown) => void): (() => void) => {
      const listener = (_event: unknown, message: unknown) => callback(message);
      ipcRenderer.on("settings-panel-message", listener);
      return () =>
        ipcRenderer.removeListener("settings-panel-message", listener);
    },
  },
  // The join QR in its own window, to park on a second screen (a laptop next
  // to the TV) so people can scan in without the big screen leaving the song.
  // No bus: it reads the hostname straight off the GraphQL server.
  qrPanel: {
    open: (): void => ipcRenderer.send("open-qr-panel"),
    close: (): void => ipcRenderer.send("close-qr-panel"),
  },
  nativeAudio: {
    // Repeatedly asking CPAL for input devices seems to cause unexpected
    // breakages, like the default output device being released. Let's avoid
    // that.
    inputDevices: memoize(nativeAudio.inputDevices),
    outputDevices: nativeAudio.outputDevices,
    inputDevice_new(name: string, channelSelection: number) {
      console.debug(
        `preload: creating input device ${inputDeviceCount}: ${name}`,
      );
      inputDevices[inputDeviceCount++] = nativeAudio.inputDevice_new(
        name,
        channelSelection,
      );
      return inputDeviceCount - 1;
    },
    inputDevice_delete(deviceId: number) {
      console.debug(`preload: deleting input device ${deviceId}`);
      delete inputDevices[deviceId];
    },
    inputDevice_getPitches(deviceId: number) {
      return nativeAudio.inputDevice_getPitches(inputDevices[deviceId]);
    },
    // Parcel rebuilds this bundle without necessarily re-copying index.node
    // (it will reuse a cached copy), so the addon behind us can be older than
    // this wrapper. A missing mic-output binding is a degraded toggle; throwing here
    // would kill the renderer's <App> and blank the big screen instead.
    inputDevice_setMicOutputEnabled(deviceId: number, enabled: boolean) {
      if (typeof nativeAudio.inputDevice_setMicOutputEnabled !== "function") {
        console.warn(
          "preload: native addon predates inputDevice_setMicOutputEnabled; ignoring mic output change",
        );
        return;
      }

      return nativeAudio.inputDevice_setMicOutputEnabled(
        inputDevices[deviceId],
        enabled,
      );
    },
    inputDevice_stop(deviceId: number) {
      return nativeAudio.inputDevice_stop(inputDevices[deviceId]);
    },
  },
});
