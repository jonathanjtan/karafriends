import M from "materialize-css";
import React, { useEffect, useRef } from "react";

import { BGM_TRACKS, SHUFFLE_VALUE } from "../common/bgmTracks";
import "./global";

interface Props {
  selected: string | null;
  onChange: (filename: string | null) => void;
}

export default function BackgroundMusicSetting({ selected, onChange }: Props) {
  const selectRef = useRef<HTMLSelectElement>(null);

  // Materialize replaces the native <select> with a fake dropdown whose
  // label is a snapshot taken at init time. The synced bgmTrack value
  // arrives async after mount (and can change remotely at any time), so the
  // wrapper must be rebuilt on every value change — otherwise it keeps
  // displaying the mount-time value ("None") even though the native select
  // underneath is correct.
  useEffect(() => {
    if (!selectRef.current) return;
    M.FormSelect.getInstance(selectRef.current)?.destroy();
    M.FormSelect.init(selectRef.current);
  }, [selected]);

  return (
    <div className="input-field">
      <select
        ref={selectRef}
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
      <label>BGM Track</label>
    </div>
  );
}
