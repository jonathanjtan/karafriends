import M from "materialize-css";
import React, { useEffect, useRef } from "react";

import "./global";
import { MicSelection } from "./settingsPanelBus";

const MicrophoneSettingOption = ({
  name,
  channel,
}: {
  name: string;
  channel: number;
}) => (
  <option data-name={name} data-channel={channel} value={`${name}_${channel}`}>
    {`${name} (Channel ${channel})`}
  </option>
);

interface Props {
  mic: MicSelection | null;
  // Only a *selection* comes back out: the InputDevice itself has to be
  // created in whichever renderer process owns the mics (see
  // settingsPanelBus.ts), which isn't necessarily this one.
  onChange: (name: string, channel: number) => void;
}

export default function MicrophoneSetting({ mic, onChange }: Props) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const value = mic ? `${mic.name}_${mic.channel}` : "";

  // Materialize snapshots the <select>'s label into its fake dropdown at init
  // time, so the wrapper has to be rebuilt whenever the value changes — in the
  // popped-out window the current selection arrives asynchronously over the
  // bus, well after mount.
  useEffect(() => {
    if (!selectRef.current) return;
    M.FormSelect.getInstance(selectRef.current)?.destroy();
    M.FormSelect.init(selectRef.current);
  }, [value]);

  return (
    <div className="input-field">
      <select
        ref={selectRef}
        value={value}
        onChange={(e) => {
          const dataset = e.target.options[e.target.selectedIndex].dataset;
          onChange(dataset.name!, parseInt(dataset.channel!, 10));
        }}
      >
        <option value="" disabled={true}>
          Select a microphone
        </option>
        {window.karafriends.nativeAudio
          .inputDevices()
          .map(([name, channelCount]) =>
            [...Array(channelCount)].map((_, i) => (
              <MicrophoneSettingOption
                key={`${name}_${i}`}
                name={name}
                channel={i}
              />
            )),
          )}
      </select>
      {/* "Input" rather than "Microphone": these now sit under a MICROPHONE
          section header, one row per mic. */}
      <label>Input</label>
    </div>
  );
}
