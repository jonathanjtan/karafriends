import type { KarafriendsConfig } from "../common/config";

declare global {
  interface Window {
    karafriends: {
      ipAddresses(): string[];
      karafriendsConfig(): KarafriendsConfig;
      saveScoreCard(meta: {
        songName: string;
        band: string;
        overall: number;
      }): Promise<string | null>;
      appendProbeLog(lines: string[]): void;
      // Broadcast bus + window control for the popped-out settings window.
      // Typed messages live in settingsPanelBus.ts.
      settingsPanel: {
        open(): void;
        close(): void;
        send(message: unknown): void;
        subscribe(callback: (message: unknown) => void): () => void;
      };
      // Window control for the popped-out join-QR window. No bus — it reads
      // the hostname over GraphQL like any other synced setting.
      qrPanel: {
        open(): void;
        close(): void;
      };
      nativeAudio: {
        inputDevices: () => [string, number][];
        outputDevices: () => string[];
        inputDevice_new: (name: string, channelSelection: number) => number;
        inputDevice_delete: (deviceId: number) => void;
        // Every reading since the last call, oldest first -- the analysis hop
        // (10ms) is finer than the caller's poll interval, so a poll collects a
        // batch rather than a value. Empty when less than one window has
        // arrived.
        inputDevice_getPitches: (deviceId: number) => {
          // Milliseconds before the moment of this call that the reading's
          // window ended. Subtract from the clock at poll time to place a
          // reading where it was actually sung.
          ageMs: number;
          midiNumber: number;
          confidence: number;
          // Absolute level (linear full-scale RMS) of the same window the
          // pitch came from. Optional because the addon behind us can predate
          // it (Parcel can reuse a cached index.node); callers must treat a
          // missing value as "don't gate".
          rms?: number;
        }[];
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
