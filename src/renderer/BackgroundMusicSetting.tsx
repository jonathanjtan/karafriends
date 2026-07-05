import M from "materialize-css";
import React, { useEffect } from "react";

import { BGM_TRACKS, SHUFFLE_VALUE } from "./bgmTracks";
import "./global";

interface Props {
  selected: string | null;
  onChange: (filename: string | null) => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
}

export default function BackgroundMusicSetting({
  selected,
  onChange,
  volume,
  onVolumeChange,
}: Props) {
  useEffect(() => {
    M.AutoInit();
  }, []);

  return (
    <div>
      <div className="input-field">
        <select
          value={selected ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : e.target.value)
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
        <label>Background Music</label>
      </div>
      <p>BGM Volume: {Math.round(volume * 100)}%</p>
      <p className="range-field">
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(volume * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
        />
      </p>
    </div>
  );
}
