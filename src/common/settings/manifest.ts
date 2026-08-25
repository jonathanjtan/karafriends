import { BGM_TRACKS, SHUFFLE_VALUE } from "../bgmTracks";
import {
  dbfsToLinear,
  linearToDbfs,
  MAX_MIC_RMS_GATE_THRESHOLD,
  MIN_MIC_RMS_GATE_THRESHOLD,
} from "../constants";
import { Control, RoomSettings } from "./useRoomSettings";

// The two places a room setting can be operated: the big screen's sidebar
// (docked or popped out) and a phone's remocon. Anything not marked otherwise
// appears on both. That default is the point of the file, and the reason a
// setting can no longer be added to one surface and forgotten on the other.
export type Surface = "tv" | "remocon";

export type SettingSection =
  | "connection"
  | "audio"
  | "microphone"
  | "scoring"
  | "pianoRoll"
  | "session"
  | "display"
  | "services";

// Render order, and the one set of section names both surfaces use. The TV
// used to say "Options" for what the remocon split into "Session Options" and
// "Display Options"; scoring used to be filed under Microphone on the remocon
// despite not being a mic setting.
export const SECTIONS: { id: SettingSection; label: string }[] = [
  // Holds no manifest entries. Each surface fills it with its own way of
  // answering "what address do people join on": the TV picks which of its
  // interfaces to advertise, the phone offers its own address as a QR.
  { id: "connection", label: "Connection" },
  { id: "audio", label: "Audio" },
  { id: "microphone", label: "Microphone" },
  { id: "scoring", label: "Scoring" },
  { id: "pianoRoll", label: "Piano Roll" },
  { id: "session", label: "Session" },
  { id: "display", label: "Display" },
  { id: "services", label: "Services" },
];

// Actions aren't settings. They're one-shot commands that live in the same
// list. Each surface supplies a handler for every id (see SettingsActions), so
// adding an action here is a compile error until both surfaces implement it.
export type SettingActionId =
  | "editBreakMessage"
  | "recheckServices"
  | "clearQueue";

export interface SettingAction {
  run: () => void;
  // Both surfaces grey out "Check Services Now" while a check is in flight
  // and "Clear Queue" while one is committing.
  disabled?: boolean;
}

export type SettingsActions = Record<SettingActionId, SettingAction>;

interface CommonDef {
  section: SettingSection;
  label: string;
  // Rendered inline on both surfaces. The TV used to hide these in `title=`
  // tooltips, which nobody hovers on a television. Pitch Gate, the setting
  // most likely to be misconfigured, was one of them.
  hint?: string;
  surfaces?: Surface[];
  // Hides the row unless the predicate passes, e.g. Gate Threshold is
  // meaningless with the gate switched off.
  visibleWhen?: (settings: RoomSettings) => boolean;
}

export type SettingDef = CommonDef &
  (
    | { kind: "toggle"; get: (s: RoomSettings) => Control<boolean> }
    | {
        kind: "slider";
        get: (s: RoomSettings) => Control<number>;
        // Slider bounds are in *display* units (percent, dB), because that's
        // what the user is reading off the row; the accessors convert.
        min: number;
        max: number;
        toDisplay: (value: number) => number;
        fromDisplay: (display: number) => number;
        format: (display: number) => string;
      }
    | {
        kind: "select";
        get: (s: RoomSettings) => Control<string | null>;
        options: { label: string; value: string | null }[];
      }
    | {
        kind: "presets";
        get: (s: RoomSettings) => Control<number>;
        presets: { label: string; value: number }[];
      }
    | { kind: "break" }
    | { kind: "action"; id: SettingActionId; destructive?: boolean }
  );

const percent = {
  toDisplay: (value: number) => Math.round(value * 100),
  fromDisplay: (display: number) => display / 100,
  format: (display: number) => `${display}%`,
};

const decibels = {
  toDisplay: (value: number) => Math.round(linearToDbfs(value)),
  fromDisplay: dbfsToLinear,
  format: (display: number) => `${display} dB`,
};

// Mirrored by both surfaces so the roll's size presets always match.
export const PIANO_ROLL_SIZE_PRESETS = [
  { label: "Off", value: 0 },
  { label: "S", value: 0.2 },
  { label: "M", value: 0.3 },
  { label: "L", value: 0.4 },
];

export const SETTINGS: SettingDef[] = [
  {
    kind: "select",
    section: "audio",
    label: "BGM Track",
    get: (s) => s.bgmTrack,
    options: [
      { label: "None", value: null },
      { label: "Shuffle", value: SHUFFLE_VALUE },
      ...BGM_TRACKS.map((track) => ({
        label: track.label,
        value: track.filename,
      })),
    ],
  },
  {
    kind: "slider",
    section: "audio",
    label: "Background Music",
    get: (s) => s.bgmVolume,
    min: 0,
    max: 100,
    ...percent,
  },
  {
    kind: "slider",
    section: "audio",
    label: "Guide Melody",
    get: (s) => s.guideMelodyVolume,
    min: 0,
    max: 150,
    ...percent,
  },
  {
    kind: "toggle",
    section: "microphone",
    label: "Software Echo",
    hint: "Add karaoke FX to mics. Disable if using hardware FX.",
    get: (s) => s.micOutputEnabled,
  },
  {
    kind: "toggle",
    section: "microphone",
    label: "Pitch Gate",
    hint: "Use when echo/reverb bleeds into the mic channels and mics have sustained or cross-channel tracking on the piano roll.",
    get: (s) => s.micRmsGateEnabled,
  },
  {
    kind: "slider",
    section: "microphone",
    label: "Gate Threshold",
    hint: "Tune pitch detection threshold.",
    get: (s) => s.micRmsGateThreshold,
    visibleWhen: (s) => s.micRmsGateEnabled.value,
    min: Math.round(linearToDbfs(MIN_MIC_RMS_GATE_THRESHOLD)),
    max: Math.round(linearToDbfs(MAX_MIC_RMS_GATE_THRESHOLD)),
    ...decibels,
  },
  {
    kind: "toggle",
    section: "scoring",
    label: "Scoring (experimental)",
    hint: "Score JOYSOUND/DAM songs against the guide melody and show a card when the song ends.",
    get: (s) => s.experimentalScoringEnabled,
  },
  {
    kind: "slider",
    section: "pianoRoll",
    label: "Opacity",
    get: (s) => s.pianoRollOpacity,
    min: 0,
    max: 100,
    ...percent,
  },
  {
    kind: "presets",
    section: "pianoRoll",
    label: "Size",
    get: (s) => s.pianoRollSize,
    presets: PIANO_ROLL_SIZE_PRESETS,
  },
  {
    kind: "toggle",
    section: "session",
    label: "Intermission",
    hint: "Cut to a fullscreen queue screen between songs.",
    get: (s) => s.queueIntermissionEnabled,
  },
  {
    kind: "break",
    section: "session",
    label: "Request Break",
    hint: "Pause the queue and show a break screen until the timer runs out.",
  },
  {
    kind: "action",
    section: "session",
    label: "Edit Break Message",
    id: "editBreakMessage",
  },
  {
    kind: "toggle",
    section: "session",
    label: "Record History",
    hint: "Log played songs to the history. Off by default in development, so test queueing doesn't count.",
    get: (s) => s.historyRecordingEnabled,
  },
  {
    kind: "toggle",
    section: "display",
    label: "OLED Mode",
    hint: "Dark theme for the big screen, easier on an OLED panel.",
    get: (s) => s.oledFriendly,
  },
  {
    kind: "toggle",
    section: "display",
    label: "EZ Romaji",
    hint: "Space JOYSOUND romaji lyrics into words instead of running them together.",
    get: (s) => s.joysoundRomajiWordSegmentation,
  },
  {
    kind: "toggle",
    section: "display",
    label: "TV Settings Panel",
    hint: "Show this settings list on the big screen too.",
    // Self-defeating on the TV: switching it off would hide the switch.
    surfaces: ["remocon"],
    get: (s) => s.tvSettingsPanelVisible,
  },
  {
    kind: "toggle",
    section: "display",
    label: "TV Sidebar",
    hint: "Off gives the playing song the whole screen.",
    // Same reason as above. The TV has its own edge tab for this.
    surfaces: ["remocon"],
    get: (s) => s.tvSidebarVisible,
  },
  {
    kind: "action",
    section: "services",
    label: "Check Services Now",
    id: "recheckServices",
  },
  {
    kind: "action",
    section: "services",
    label: "Clear Queue",
    id: "clearQueue",
    destructive: true,
  },
];

export function settingsForSurface(
  surface: Surface,
  section: SettingSection,
  settings: RoomSettings,
): SettingDef[] {
  return SETTINGS.filter(
    (def) =>
      def.section === section &&
      (def.surfaces ?? ["tv", "remocon"]).includes(surface) &&
      (def.visibleWhen === undefined || def.visibleWhen(settings)),
  );
}
