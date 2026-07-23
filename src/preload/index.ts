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
  // Capture the current score card to Pictures/karafriends. Resolves to the
  // saved path, or null if the grab failed (the main handler swallows errors).
  saveScoreCard: (meta: {
    songName: string;
    band: string;
    overall: number;
  }): Promise<string | null> => ipcRenderer.invoke("save-score-card", meta),
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
    inputDevice_getPitch(deviceId: number) {
      return nativeAudio.inputDevice_getPitch(inputDevices[deviceId]);
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
