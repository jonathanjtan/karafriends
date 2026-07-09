import classnames from "classnames";
import React from "react";

import { BGM_TRACKS, SHUFFLE_VALUE } from "../../../common/bgmTracks";
import useBgmTrack from "../../../common/hooks/useBgmTrack";
import useBgmVolume from "../../../common/hooks/useBgmVolume";
import usePianoRollOpacity from "../../../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../../../common/hooks/usePianoRollSize";
import useConfig from "../../hooks/useConfig";
import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./VolumeControls.module.scss";

const PIANO_ROLL_SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "Off", size: 0 },
  { label: "S", size: 0.2 },
  { label: "M", size: 0.3 },
  { label: "L", size: 0.4 },
];

const VolumeControls = () => {
  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { pianoRollOpacity, setPianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize, setPianoRollSize } = usePianoRollSize();

  const config = useConfig();
  const identity = useUserIdentity();

  // Global volumes affect the whole room; in supervised mode only admins get
  // to touch them (same policy as playback controls).
  const disabled =
    config !== undefined &&
    config.supervisedMode === true &&
    !config.adminNicks.includes(identity.nickname) &&
    !config.adminDeviceIds.includes(identity.deviceId);

  return (
    <div className={classnames(styles.panel, { [styles.disabled]: disabled })}>
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
      <div>
        <div className={styles.labelRow}>
          <span>Piano Roll Opacity</span>
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
          <span>Piano Roll Size</span>
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
    </div>
  );
};

export default VolumeControls;
