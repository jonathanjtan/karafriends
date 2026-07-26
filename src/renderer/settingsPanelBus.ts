import "./global";

// Messages exchanged between the big screen (<App>) and the popped-out
// settings window (<SettingsPanel>), relayed by the main process.
//
// Everything else in the sidebar is a *synced setting* — it lives in the main
// process and both surfaces reach it over GraphQL, so it needs nothing here.
// This bus exists only for the two pieces of sidebar state that are owned by
// the big-screen renderer process and can't be moved:
//
//   - the mics: `InputDevice`s are created through the preload's native addon
//     binding, so they belong to the process whose PianoRoll polls them. A mic
//     created in the panel's process would be a second, silent capture stream.
//   - the mic levels: published by PianoRoll's pitch poller at ~40Hz (see
//     MicLevelMeters on why nothing else may poll getPitch).
//
// The big screen is the owner: the panel sends intents ("select this mic") and
// renders whatever snapshot comes back.

export interface MicSelection {
  name: string;
  channel: number;
}

export type SettingsPanelMessage =
  // panel -> big screen
  | { type: "requestOwnerState" }
  | { type: "panelOpened" }
  | { type: "setMic"; index: number; name: string; channel: number }
  | { type: "clearMics" }
  | { type: "setHostname"; hostname: string }
  // big screen -> panel
  | { type: "ownerState"; mics: MicSelection[]; hostname: string }
  | { type: "micLevels"; levels: number[] }
  // main process -> big screen, when the panel window is gone
  | { type: "panelClosed" };

export function sendSettingsPanelMessage(message: SettingsPanelMessage): void {
  window.karafriends.settingsPanel.send(message);
}

export function openSettingsPanelWindow(): void {
  window.karafriends.settingsPanel.open();
}

export function closeSettingsPanelWindow(): void {
  window.karafriends.settingsPanel.close();
}

// Returns an unsubscribe function, so callers can hand it straight back from a
// useEffect.
export function subscribeSettingsPanelMessages(
  callback: (message: SettingsPanelMessage) => void,
): () => void {
  return window.karafriends.settingsPanel.subscribe((message) =>
    callback(message as SettingsPanelMessage),
  );
}

// The renderer bundle is loaded in two windows; this is how each one knows
// which it is (main/index.ts appends the query for the panel window).
export function isSettingsPanelWindow(): boolean {
  return (
    new URLSearchParams(window.location.search).get("panel") === "settings"
  );
}
