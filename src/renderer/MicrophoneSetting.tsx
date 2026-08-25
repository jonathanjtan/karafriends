import M from "materialize-css";
import React, { useEffect, useRef, useState } from "react";

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
  // Bumped on every pick so the effect below re-runs even when `value` itself
  // doesn't change. The trailing "add a mic" row is always rendered with
  // mic={null}. Picking in it appends a *new* row upstream and leaves this
  // one on "", so without this the fake dropdown would keep displaying the
  // device that was just picked while the real <select> is back on the
  // placeholder.
  const [pickSeq, setPickSeq] = useState(0);

  // Materialize snapshots the <select>'s label into its fake dropdown at init
  // time, so the wrapper has to be rebuilt whenever the value changes. In the
  // popped-out window the current selection arrives asynchronously over the
  // bus, well after mount.
  useEffect(() => {
    if (!selectRef.current) return;
    M.FormSelect.getInstance(selectRef.current)?.destroy();
    M.FormSelect.init(selectRef.current);
  }, [value, pickSeq]);

  return (
    <div className="input-field">
      <select
        ref={selectRef}
        value={value}
        onChange={(e) => {
          const dataset = e.target.options[e.target.selectedIndex].dataset;
          setPickSeq((seq) => seq + 1);
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
