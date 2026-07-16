import classnames from "classnames";
import React, { useEffect, useState } from "react";
import { graphql, useMutation } from "react-relay";

import { BGM_TRACKS, SHUFFLE_VALUE } from "../../../common/bgmTracks";
import useBgmTrack from "../../../common/hooks/useBgmTrack";
import useBgmVolume from "../../../common/hooks/useBgmVolume";
import useBreakEndsAt from "../../../common/hooks/useBreakEndsAt";
import useBreakMessage from "../../../common/hooks/useBreakMessage";
import useGuideMelodyVolume from "../../../common/hooks/useGuideMelodyVolume";
import useOledFriendly from "../../../common/hooks/useOledFriendly";
import usePianoRollOpacity from "../../../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../../../common/hooks/usePianoRollSize";
import useQueueIntermissionEnabled from "../../../common/hooks/useQueueIntermissionEnabled";
import useSettingsCollapsed from "../../../common/hooks/useSettingsCollapsed";
import useSidebarCollapsed from "../../../common/hooks/useSidebarCollapsed";
import useConfig from "../../hooks/useConfig";
import useServiceHealth from "../../hooks/useServiceHealth";
import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./VolumeControls.module.scss";
import { VolumeControlsClearQueueMutation } from "./__generated__/VolumeControlsClearQueueMutation.graphql";

const clearQueueMutation = graphql`
  mutation VolumeControlsClearQueueMutation {
    clearQueue
  }
`;

const DEFAULT_BREAK_MESSAGE = "⚠️ Don't forget to stay hydrated!";

const PIANO_ROLL_SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "Off", size: 0 },
  { label: "S", size: 0.2 },
  { label: "M", size: 0.3 },
  { label: "L", size: 0.4 },
];

const VolumeControls = () => {
  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { guideMelodyVolume, setGuideMelodyVolume } = useGuideMelodyVolume();
  const { pianoRollOpacity, setPianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize, setPianoRollSize } = usePianoRollSize();
  const { queueIntermissionEnabled, setQueueIntermissionEnabled } =
    useQueueIntermissionEnabled();
  const { breakEndsAt, setBreakEndsAt } = useBreakEndsAt();
  const { setBreakMessage } = useBreakMessage();
  // Break length is a per-phone choice; only the break itself is synced.
  const [breakMinutes, setBreakMinutes] = useState(5);
  // Tick while a break is active so the End Break countdown stays live. The
  // renderer clears breakEndsAt server-side when it expires, which flips the
  // button back via the subscription.
  const [breakNow, setBreakNow] = useState(() => Date.now());
  const breakActive = breakEndsAt !== null;
  useEffect(() => {
    if (!breakActive) return;
    setBreakNow(Date.now());
    const timer = setInterval(() => setBreakNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [breakActive]);
  const breakRemainingSecs = breakActive
    ? Math.max(Math.round((breakEndsAt - breakNow) / 1000), 0)
    : 0;
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarCollapsed();
  const { oledFriendly, setOledFriendly } = useOledFriendly();
  const { serviceHealth, isRechecking, recheck } = useServiceHealth();
  const [commitClearQueue, isClearingQueue] =
    useMutation<VolumeControlsClearQueueMutation>(clearQueueMutation);

  const config = useConfig();
  const identity = useUserIdentity();

  // Global volumes affect the whole room; in supervised mode only admins get
  // to touch them (same policy as playback controls).
  const disabled =
    config !== undefined &&
    config.supervisedMode === true &&
    !config.adminNicks.includes(identity.nickname) &&
    !config.adminDeviceIds.includes(identity.deviceId);

  const healthIcon = (available: boolean | undefined) => {
    if (isRechecking) return <span className={styles.healthSpinner} />;
    return available === false ? "⚠️" : "✅";
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Settings</span>
      </div>
      <div className={classnames(styles.body, { [styles.disabled]: disabled })}>
        <div>
          <div className={styles.labelRow}>
            <span>BGM Track</span>
          </div>
          <select
            className={styles.trackSelect}
            value={bgmTrack ?? ""}
            onChange={(e) =>
              setBgmTrack(e.target.value === "" ? null : e.target.value)
            }
          >
            <option value="">None</option>
            <option value={SHUFFLE_VALUE}>Shuffle</option>
            {BGM_TRACKS.map((t) => (
              <option key={t.filename} value={t.filename}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.sectionHeader}>Volume</div>
        <div>
          <div className={styles.labelRow}>
            <span>Background Music</span>
            <span>{Math.round(bgmVolume * 100)}%</span>
          </div>
          <input
            className={styles.slider}
            type="range"
            min="0"
            max="100"
            value={Math.round(bgmVolume * 100)}
            onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
          />
        </div>
        <div>
          <div className={styles.labelRow}>
            <span>Guide Melody</span>
            <span>{Math.round(guideMelodyVolume * 100)}%</span>
          </div>
          <input
            className={styles.slider}
            type="range"
            min="0"
            max="150"
            value={Math.round(guideMelodyVolume * 100)}
            onChange={(e) => setGuideMelodyVolume(Number(e.target.value) / 100)}
          />
        </div>
        <div className={styles.sectionHeader}>Piano Roll</div>
        <div>
          <div className={styles.labelRow}>
            <span>Opacity</span>
            <span>{Math.round(pianoRollOpacity * 100)}%</span>
          </div>
          <input
            className={styles.slider}
            type="range"
            min="0"
            max="100"
            value={Math.round(pianoRollOpacity * 100)}
            onChange={(e) => setPianoRollOpacity(Number(e.target.value) / 100)}
          />
        </div>
        <div>
          <div className={styles.labelRow}>
            <span>Size</span>
            <span className={styles.sizeButtons}>
              {PIANO_ROLL_SIZE_PRESETS.map(({ label, size }) => (
                <button
                  key={label}
                  className={classnames(styles.sizeButton, {
                    [styles.sizeButtonActive]:
                      Math.abs(pianoRollSize - size) < 0.001,
                  })}
                  onClick={() => setPianoRollSize(size)}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        </div>
        <div className={styles.sectionHeader}>Session Options</div>
        <div>
          <button
            className={styles.recheckButton}
            onClick={() =>
              setQueueIntermissionEnabled(!queueIntermissionEnabled)
            }
          >
            Intermission: {queueIntermissionEnabled ? "On" : "Off"}
          </button>
        </div>
        <div className={styles.breakRow}>
          <button
            className={styles.sizeButton}
            onClick={() =>
              breakActive
                ? setBreakEndsAt(Math.max(breakEndsAt! - 60 * 1000, Date.now()))
                : setBreakMinutes(Math.max(breakMinutes - 1, 1))
            }
          >
            −
          </button>
          <button
            className={classnames(styles.breakActionButton, {
              [styles.breakActionButtonActive]: breakActive,
            })}
            onClick={() => {
              const now = Date.now();
              setBreakNow(now);
              setBreakEndsAt(
                breakActive ? null : now + breakMinutes * 60 * 1000,
              );
            }}
          >
            {breakActive
              ? `${Math.floor(breakRemainingSecs / 60)}:${String(
                  breakRemainingSecs % 60,
                ).padStart(2, "0")}`
              : `${breakMinutes}:00`}
          </button>
          <button
            className={styles.sizeButton}
            onClick={() =>
              breakActive
                ? setBreakEndsAt(breakEndsAt! + 60 * 1000)
                : setBreakMinutes(breakMinutes + 1)
            }
          >
            +
          </button>
        </div>
        <div>
          <button
            className={styles.recheckButton}
            onClick={() => {
              const input = window.prompt(
                "Break message:",
                DEFAULT_BREAK_MESSAGE,
              );
              if (input === null) return;
              const trimmed = input.trim();
              if (trimmed === "") return;
              setBreakMessage(trimmed, identity.nickname || null);
            }}
          >
            Edit Break Message
          </button>
        </div>
        <div className={styles.sectionHeader}>Display Options</div>
        <div>
          <button
            className={styles.recheckButton}
            onClick={() => setSettingsCollapsed(!settingsCollapsed)}
          >
            {settingsCollapsed
              ? "Show TV Settings Panel"
              : "Hide TV Settings Panel"}
          </button>
        </div>
        <div>
          <button
            className={styles.recheckButton}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed
              ? "Expand TV Sidebar"
              : "Collapse TV Sidebar (Fullscreen Song)"}
          </button>
        </div>
        <div>
          <button
            className={styles.recheckButton}
            onClick={() => setOledFriendly(!oledFriendly)}
          >
            OLED Mode: {oledFriendly ? "On" : "Off"}
          </button>
        </div>
        <div className={styles.serviceHealth}>
          <div className={styles.healthRow}>
            <span>DAM</span>
            <span>{healthIcon(serviceHealth?.damAvailable)}</span>
          </div>
          <div className={styles.healthRow}>
            <span>Joysound</span>
            <span>{healthIcon(serviceHealth?.joysoundAvailable)}</span>
          </div>
          <button
            className={styles.recheckButton}
            disabled={isRechecking}
            onClick={recheck}
          >
            Check Service Status Now
          </button>
        </div>
        <div>
          <button
            className={styles.clearQueueButton}
            disabled={isClearingQueue}
            onClick={() => {
              if (
                window.confirm("Clear the queue and skip the current song?")
              ) {
                commitClearQueue({ variables: {} });
              }
            }}
          >
            Clear Queue
          </button>
        </div>
      </div>
    </div>
  );
};

export default VolumeControls;
