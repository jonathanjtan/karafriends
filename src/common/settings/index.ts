// The shared half of the settings UI: what settings exist, what they're
// called, and how to read/write them. The two surfaces (renderer/Sidebar and
// remocon/SettingsPanel) each supply only a presenter — a switch over
// `SettingDef["kind"]` in their own styling — so a new setting is one edit
// here rather than two edits that can disagree.
export {
  PIANO_ROLL_SIZE_PRESETS,
  SECTIONS,
  SETTINGS,
  settingsForSurface,
} from "./manifest";
export type {
  SettingAction,
  SettingActionId,
  SettingDef,
  SettingSection,
  SettingsActions,
  Surface,
} from "./manifest";
export { default as useRoomSettings } from "./useRoomSettings";
export type { BreakControls, Control, RoomSettings } from "./useRoomSettings";
