import React from "react";

import { RoomSettings, SettingDef, SettingsActions } from "../common/settings";

// The big screen's presenter for one manifest entry. Renders into the
// sidebar's 3-column grid (label | control | value) using materialize
// classes; the remocon has its own presenter over the same manifest.
export default function SettingRow(props: {
  def: SettingDef;
  settings: RoomSettings;
  actions: SettingsActions;
}) {
  const { def, settings, actions } = props;

  // Hints used to be `title=` tooltips here, which is useless on a screen
  // nobody hovers. They're a real row now, spanning the whole grid width.
  const hint = def.hint ? (
    <span className="settingHint">{def.hint}</span>
  ) : null;

  switch (def.kind) {
    case "toggle": {
      const control = def.get(settings);
      return (
        <>
          <span
            className="settingLabel settingLabelClickable"
            onClick={() => control.set(!control.value)}
          >
            {def.label}
          </span>
          <div className="switch settingControlWide">
            <label>
              <input
                type="checkbox"
                checked={control.value}
                onChange={(e) => control.set(e.target.checked)}
              />
              <span className="lever" />
            </label>
          </div>
          {hint}
        </>
      );
    }

    case "slider": {
      const control = def.get(settings);
      const display = def.toDisplay(control.value);
      return (
        <>
          <span className="settingLabel">{def.label}</span>
          <span className="settingValue">{def.format(display)}</span>
          <span className="range-field settingControl">
            <input
              type="range"
              min={def.min}
              max={def.max}
              value={display}
              onChange={(e) =>
                control.set(def.fromDisplay(Number(e.target.value)))
              }
            />
          </span>
          {hint}
        </>
      );
    }

    case "select": {
      const control = def.get(settings);
      return (
        <>
          <span className="settingLabel">{def.label}</span>
          <span className="settingControlWide">
            {/* browser-default: materialize's FormSelect replaces the element
                with its own DOM, which needs re-initialising every time the
                value changes underneath it (see HostnameSetting). Not worth
                it for a plain list. */}
            <select
              className="browser-default settingSelect"
              value={control.value ?? ""}
              onChange={(e) =>
                control.set(e.target.value === "" ? null : e.target.value)
              }
            >
              {def.options.map((option) => (
                <option key={option.label} value={option.value ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
          {hint}
        </>
      );
    }

    case "presets": {
      const control = def.get(settings);
      return (
        <>
          <span className="settingLabel">{def.label}</span>
          <div className="pianoRollSizeButtons settingControlWide">
            {def.presets.map((preset) => (
              <button
                key={preset.label}
                className={`btn-small ${
                  Math.abs(control.value - preset.value) < 0.001 ? "" : "grey"
                }`}
                onClick={() => control.set(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {hint}
        </>
      );
    }

    case "break":
      return (
        <>
          <span className="settingLabel">{def.label}</span>
          <div className="pianoRollSizeButtons breakButtons settingControlWide">
            <button
              className="btn-small grey"
              onClick={settings.break.decrement}
            >
              −
            </button>
            <button
              className={
                settings.break.active
                  ? "btn-small breakActionButton breakActionButtonActive"
                  : "btn-small breakActionButton"
              }
              onClick={settings.break.toggle}
            >
              {settings.break.label}
            </button>
            <button
              className="btn-small grey"
              onClick={settings.break.increment}
            >
              +
            </button>
          </div>
          {hint}
        </>
      );

    case "action": {
      const action = actions[def.id];
      return (
        <>
          <div className="settingFullRow">
            <button
              className={def.destructive ? "btn red" : "btn"}
              disabled={action.disabled}
              onClick={action.run}
            >
              {def.label}
            </button>
          </div>
          {hint}
        </>
      );
    }
  }
}
