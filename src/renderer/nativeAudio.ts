const registry = new FinalizationRegistry(
  window.karafriends.nativeAudio.inputDevice_delete,
);

export class InputDevice {
  deviceId: number;
  name: string;
  channelSelection: number;

  constructor(name: string, channelSelection: number) {
    this.deviceId = window.karafriends.nativeAudio.inputDevice_new(
      name,
      channelSelection,
    );
    this.name = name;
    this.channelSelection = channelSelection;
    registry.register(this, this.deviceId);
  }

  // Every reading since the last call, oldest first. Batched because the
  // detector's hop is finer than this poll -- see the Rust pitch_framer.
  getPitches() {
    return window.karafriends.nativeAudio.inputDevice_getPitches(this.deviceId);
  }

  // Mutes/unmutes this mic in the room's speakers only; getPitch keeps
  // returning live pitch either way, so the piano roll and scoring survive
  // being mixed through an external mixer instead.
  //
  // The addon can be older than the JS that calls it: `parcel watch` only
  // rebuilds the remocon and renderer targets, and Parcel will happily reuse a
  // cached copy of index.node under build/dev while rebuilding the preload
  // bundle around it. This is a comfort toggle — an inert one beats an
  // uncaught throw, which takes <App> (and with it the whole big screen) down
  // and, once a mic is saved to localStorage, keeps doing so on every relaunch.
  setMicOutputEnabled(enabled: boolean) {
    if (
      typeof window.karafriends.nativeAudio.inputDevice_setMicOutputEnabled !==
      "function"
    ) {
      console.warn(
        "Native addon predates inputDevice_setMicOutputEnabled; mic output cannot be toggled. Rebuild the native addon (yarn build-native-dev) and clear Parcel's cache so the fresh index.node is copied into build/.",
      );
      return;
    }

    return window.karafriends.nativeAudio.inputDevice_setMicOutputEnabled(
      this.deviceId,
      enabled,
    );
  }

  stop() {
    return window.karafriends.nativeAudio.inputDevice_stop(this.deviceId);
  }
}
