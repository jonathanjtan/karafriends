import { useEffect, useState } from "react";

import useBgmTrack from "../hooks/useBgmTrack";
import useBgmVolume from "../hooks/useBgmVolume";
import useBreakEndsAt from "../hooks/useBreakEndsAt";
import useBreakMessage from "../hooks/useBreakMessage";
import useExperimentalScoringEnabled from "../hooks/useExperimentalScoringEnabled";
import useGuideMelodyVolume from "../hooks/useGuideMelodyVolume";
import useHistoryRecordingEnabled from "../hooks/useHistoryRecordingEnabled";
import useJoysoundRomajiWordSegmentation from "../hooks/useJoysoundRomajiWordSegmentation";
import useMicOutputEnabled from "../hooks/useMicOutputEnabled";
import useMicRmsGateEnabled from "../hooks/useMicRmsGateEnabled";
import useMicRmsGateThreshold from "../hooks/useMicRmsGateThreshold";
import useOledFriendly from "../hooks/useOledFriendly";
import usePianoRollOpacity from "../hooks/usePianoRollOpacity";
import usePianoRollSize from "../hooks/usePianoRollSize";
import useQueueIntermissionEnabled from "../hooks/useQueueIntermissionEnabled";
import useSettingsCollapsed from "../hooks/useSettingsCollapsed";
import useSidebarCollapsed from "../hooks/useSidebarCollapsed";

// One read/write handle on a synced setting. Every setting hook in
// common/hooks already has this shape under a different pair of names; this
// normalizes them so the manifest can address them uniformly.
export interface Control<T> {
  value: T;
  set: (value: T) => void;
}

// The break's −/[time]/+ trio. Shared rather than reimplemented per surface:
// only `breakEndsAt` is synced, but the pending duration, the live countdown
// and the "does − shorten the running break or the pending one" rule are the
// same everywhere, and were previously duplicated (identically) in both.
export interface BreakControls {
  active: boolean;
  // What the middle button reads: the pending length when idle, the live
  // countdown while a break is running.
  label: string;
  decrement: () => void;
  increment: () => void;
  toggle: () => void;
}

export interface RoomSettings {
  bgmTrack: Control<string | null>;
  bgmVolume: Control<number>;
  guideMelodyVolume: Control<number>;
  micOutputEnabled: Control<boolean>;
  micRmsGateEnabled: Control<boolean>;
  micRmsGateThreshold: Control<number>;
  experimentalScoringEnabled: Control<boolean>;
  historyRecordingEnabled: Control<boolean>;
  pianoRollOpacity: Control<number>;
  pianoRollSize: Control<number>;
  queueIntermissionEnabled: Control<boolean>;
  oledFriendly: Control<boolean>;
  joysoundRomajiWordSegmentation: Control<boolean>;
  // Stored inverted (`collapsed`); exposed as "is it showing" so a switch
  // being on means the thing is visible on both surfaces.
  tvSettingsPanelVisible: Control<boolean>;
  tvSidebarVisible: Control<boolean>;
  break: BreakControls;
  setBreakMessage: (text: string, author: string | null) => void;
}

const DEFAULT_BREAK_MINUTES = 5;

// Calls every synced-setting hook, unconditionally and in a fixed order, and
// hands back one keyed map. This is what lets the settings UI be driven by a
// pure-data manifest: React's rules of hooks are satisfied here, once, and
// the manifest never calls a hook of its own.
//
// Both surfaces already mounted all of these at the top of their settings
// component, so nothing new is being subscribed to.
export default function useRoomSettings(): RoomSettings {
  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { guideMelodyVolume, setGuideMelodyVolume } = useGuideMelodyVolume();
  const { micOutputEnabled, setMicOutputEnabled } = useMicOutputEnabled();
  const { micRmsGateEnabled, setMicRmsGateEnabled } = useMicRmsGateEnabled();
  const { micRmsGateThreshold, setMicRmsGateThreshold } =
    useMicRmsGateThreshold();
  const { experimentalScoringEnabled, setExperimentalScoringEnabled } =
    useExperimentalScoringEnabled();
  const { historyRecordingEnabled, setHistoryRecordingEnabled } =
    useHistoryRecordingEnabled();
  const { pianoRollOpacity, setPianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize, setPianoRollSize } = usePianoRollSize();
  const { queueIntermissionEnabled, setQueueIntermissionEnabled } =
    useQueueIntermissionEnabled();
  const { oledFriendly, setOledFriendly } = useOledFriendly();
  const { joysoundRomajiWordSegmentation, setJoysoundRomajiWordSegmentation } =
    useJoysoundRomajiWordSegmentation();
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarCollapsed();
  const { breakEndsAt, setBreakEndsAt } = useBreakEndsAt();
  const { setBreakMessage } = useBreakMessage();

  // Break length is a per-screen choice; only the break itself is synced.
  const [breakMinutes, setBreakMinutes] = useState(DEFAULT_BREAK_MINUTES);
  const breakActive = breakEndsAt !== null;
  // Tick while a break is active so the countdown stays live. `breakNow` only
  // refreshes here, so a stale value can otherwise sit around between one
  // break ending and the next starting; without the immediate refresh below, a
  // newly-started break's remaining time would briefly be computed against
  // that stale timestamp (jumping to an inflated value before the first 1s
  // tick corrects it).
  const [breakNow, setBreakNow] = useState(() => Date.now());
  useEffect(() => {
    if (!breakActive) return;
    setBreakNow(Date.now());
    const timer = setInterval(() => setBreakNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [breakActive]);

  const breakRemainingSecs = breakActive
    ? Math.max(Math.round((breakEndsAt - breakNow) / 1000), 0)
    : 0;

  return {
    bgmTrack: { value: bgmTrack, set: setBgmTrack },
    bgmVolume: { value: bgmVolume, set: setBgmVolume },
    guideMelodyVolume: { value: guideMelodyVolume, set: setGuideMelodyVolume },
    micOutputEnabled: { value: micOutputEnabled, set: setMicOutputEnabled },
    micRmsGateEnabled: { value: micRmsGateEnabled, set: setMicRmsGateEnabled },
    micRmsGateThreshold: {
      value: micRmsGateThreshold,
      set: setMicRmsGateThreshold,
    },
    experimentalScoringEnabled: {
      value: experimentalScoringEnabled,
      set: setExperimentalScoringEnabled,
    },
    historyRecordingEnabled: {
      value: historyRecordingEnabled,
      set: setHistoryRecordingEnabled,
    },
    pianoRollOpacity: { value: pianoRollOpacity, set: setPianoRollOpacity },
    pianoRollSize: { value: pianoRollSize, set: setPianoRollSize },
    queueIntermissionEnabled: {
      value: queueIntermissionEnabled,
      set: setQueueIntermissionEnabled,
    },
    oledFriendly: { value: oledFriendly, set: setOledFriendly },
    joysoundRomajiWordSegmentation: {
      value: joysoundRomajiWordSegmentation,
      set: setJoysoundRomajiWordSegmentation,
    },
    tvSettingsPanelVisible: {
      value: !settingsCollapsed,
      set: (visible) => setSettingsCollapsed(!visible),
    },
    tvSidebarVisible: {
      value: !sidebarCollapsed,
      set: (visible) => setSidebarCollapsed(!visible),
    },
    break: {
      active: breakActive,
      label: breakActive
        ? `${Math.floor(breakRemainingSecs / 60)}:${String(
            breakRemainingSecs % 60,
          ).padStart(2, "0")}`
        : `${breakMinutes}:00`,
      // While a break runs, ± move its deadline; while idle, they set how long
      // the next one will be. Never below "now" — a deadline in the past would
      // read as a negative countdown.
      decrement: () =>
        breakActive
          ? setBreakEndsAt(Math.max(breakEndsAt! - 60 * 1000, Date.now()))
          : setBreakMinutes(Math.max(breakMinutes - 1, 1)),
      increment: () =>
        breakActive
          ? setBreakEndsAt(breakEndsAt! + 60 * 1000)
          : setBreakMinutes(breakMinutes + 1),
      toggle: () => {
        const now = Date.now();
        setBreakNow(now);
        setBreakEndsAt(breakActive ? null : now + breakMinutes * 60 * 1000);
      },
    },
    setBreakMessage,
  };
}
