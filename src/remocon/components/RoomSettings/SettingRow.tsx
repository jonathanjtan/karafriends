import classnames from "classnames";
import React from "react";

import {
  RoomSettings,
  SettingDef,
  SettingsActions,
} from "../../../common/settings";
import Slider from "../Slider";

import * as styles from "./RoomSettings.module.scss";

// The phone's presenter for one manifest entry. Stacked full-width rows with
// big touch targets; the big screen has its own presenter over the same
// manifest (renderer/SettingRow.tsx).
export default function SettingRow(props: {
  def: SettingDef;
  settings: RoomSettings;
  actions: SettingsActions;
}) {
  const { def, settings, actions } = props;

  const hint = def.hint ? <div className={styles.hint}>{def.hint}</div> : null;

  switch (def.kind) {
    case "toggle": {
      const control = def.get(settings);
      return (
        <div className={styles.row}>
          {/* The whole row is the target — these used to be full-width
              buttons labelled "Software Echo: Off", where it was never clear
              whether tapping *set* Off or toggled away from it. A switch
              shows state and the tap changes it. */}
          <button
            className={styles.toggleRow}
            role="switch"
            aria-checked={control.value}
            onClick={() => control.set(!control.value)}
          >
            <span className={styles.toggleLabel}>{def.label}</span>
            <span
              className={classnames(styles.switchTrack, {
                [styles.switchTrackOn]: control.value,
              })}
              aria-hidden="true"
            >
              <span className={styles.switchThumb} />
            </span>
          </button>
          {hint}
        </div>
      );
    }

    case "slider": {
      const control = def.get(settings);
      const display = def.toDisplay(control.value);
      return (
        <div className={styles.row}>
          <div className={styles.labelRow}>
            <span>{def.label}</span>
            <span className={styles.value}>{def.format(display)}</span>
          </div>
          <Slider
            className={styles.slider}
            min={def.min}
            max={def.max}
            value={display}
            onChange={(e) =>
              control.set(def.fromDisplay(Number(e.target.value)))
            }
          />
          {hint}
        </div>
      );
    }

    case "select": {
      const control = def.get(settings);
      return (
        <div className={styles.row}>
          <div className={styles.labelRow}>
            <span>{def.label}</span>
          </div>
          <select
            className={styles.select}
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
          {hint}
        </div>
      );
    }

    case "presets": {
      const control = def.get(settings);
      return (
        <div className={styles.row}>
          <div className={styles.labelRow}>
            <span>{def.label}</span>
            <span className={styles.segmented}>
              {def.presets.map((preset) => (
                <button
                  key={preset.label}
                  className={classnames(styles.segment, {
                    [styles.segmentActive]:
                      Math.abs(control.value - preset.value) < 0.001,
                  })}
                  onClick={() => control.set(preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </span>
          </div>
          {hint}
        </div>
      );
    }

    case "break":
      return (
        <div className={styles.row}>
          <div className={styles.labelRow}>
            <span>{def.label}</span>
          </div>
          <div className={styles.breakRow}>
            <button
              className={styles.segment}
              onClick={settings.break.decrement}
            >
              −
            </button>
            <button
              className={classnames(styles.breakActionButton, {
                [styles.breakActionButtonActive]: settings.break.active,
              })}
              onClick={settings.break.toggle}
            >
              {settings.break.label}
            </button>
            <button
              className={styles.segment}
              onClick={settings.break.increment}
            >
              +
            </button>
          </div>
          {hint}
        </div>
      );

    case "action": {
      const action = actions[def.id];
      return (
        <div className={styles.row}>
          <button
            className={classnames(styles.actionButton, {
              [styles.actionButtonDestructive]: def.destructive,
            })}
            disabled={action.disabled}
            onClick={action.run}
          >
            {def.label}
          </button>
          {hint}
        </div>
      );
    }
  }
}
