import type { KarafriendsConfig } from "../common/config";

declare global {
  interface Window {
    karafriends: {
      ipAddresses(): string[];
      karafriendsConfig(): KarafriendsConfig;
      nativeAudio: {
        inputDevices: () => [string, number][];
        outputDevices: () => string[];
        inputDevice_new: (name: string, channelSelection: number) => number;
        inputDevice_delete: (deviceId: number) => void;
        inputDevice_getPitch: (deviceId: number) => {
          midiNumber: number;
          confidence: number;
          // Absolute level (linear full-scale RMS) of the same window the
          // pitch came from. Optional because the addon behind us can predate
          // it (Parcel can reuse a cached index.node); callers must treat a
          // missing value as "don't gate".
          rms?: number;
        };
        inputDevice_setMicOutputEnabled: (
          deviceId: number,
          enabled: boolean,
        ) => void;
        inputDevice_stop: (deviceId: number) => void;
      };
    };
  }

  class FinalizationRegistry<T> {
    constructor(callback: (heldValue: T) => void);
    register(target: object, heldValue: T): void;
  }
}

export {};
