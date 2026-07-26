import React, { useEffect, useState } from "react";
import {
  FaChevronDown,
  FaChevronUp,
  FaCompressAlt,
  FaExternalLinkAlt,
} from "react-icons/fa"; // tslint:disable-line:no-submodule-imports

import {
  dbfsToLinear,
  linearToDbfs,
  MAX_MIC_RMS_GATE_THRESHOLD,
  MIN_MIC_RMS_GATE_THRESHOLD,
} from "../common/constants";
import useBgmTrack from "../common/hooks/useBgmTrack";
import useBgmVolume from "../common/hooks/useBgmVolume";
import useBreakEndsAt from "../common/hooks/useBreakEndsAt";
import useGuideMelodyVolume from "../common/hooks/useGuideMelodyVolume";
import useJoysoundRomajiWordSegmentation from "../common/hooks/useJoysoundRomajiWordSegmentation";
import useMicOutputEnabled from "../common/hooks/useMicOutputEnabled";
import useMicRmsGateEnabled from "../common/hooks/useMicRmsGateEnabled";
import useMicRmsGateThreshold from "../common/hooks/useMicRmsGateThreshold";
import useOledFriendly from "../common/hooks/useOledFriendly";
import usePianoRollOpacity from "../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import useQueueIntermissionEnabled from "../common/hooks/useQueueIntermissionEnabled";
import { ServiceHealthState } from "../common/hooks/useServiceHealth";
import useSettingsCollapsed from "../common/hooks/useSettingsCollapsed";
import BackgroundMusicSetting from "./BackgroundMusicSetting";
import HostnameSetting from "./HostnameSetting";
import MicLevelMeters from "./MicLevelMeters";
import MicrophoneSetting from "./MicrophoneSetting";
import QRCode from "./QRCode";
import Queue from "./Queue";
import { MicSelection } from "./settingsPanelBus";

// Mirror the remocon's Piano Roll Size presets so both surfaces match.
const PIANO_ROLL_SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "Off", size: 0 },
  { label: "S", size: 0.2 },
  { label: "M", size: 0.3 },
  { label: "L", size: 0.4 },
];

interface Props {
  // "docked" is the column beside the video in the big-screen window;
  // "window" is the popped-out settings window, which fills its own window
  // and can't be collapsed or resized by the drag handle.
  variant: "docked" | "window";
  // Mic hardware and the remocon hostname belong to the big screen's renderer
  // process, so both arrive as props and changes go back out as callbacks —
  // in the popped-out window those callbacks travel over the bus. See
  // settingsPanelBus.ts.
  hostname: string;
  onHostnameChange: (hostname: string) => void;
  mics: MicSelection[];
  onSelectMic: (index: number, name: string, channel: number) => void;
  onClearMics: () => void;
  micLevelsRef: React.MutableRefObject<number[]>;
  serviceHealth: ServiceHealthState | null;
  isRecheckingServiceHealth: boolean;
  onRecheckServiceHealth: () => void;
  isClearingQueue: boolean;
  onClearQueue: () => void;
  // Docked only: the drag-to-resize strip and the inline width.
  style?: React.CSSProperties;
  onResizeHandleMouseDown?: (event: React.MouseEvent) => void;
  // Docked: detach into its own window. Window: close and re-dock.
  onPopOut?: () => void;
  onDock?: () => void;
  // True while the settings window is open, so the docked sidebar can say so
  // instead of pretending its (hidden) copy is the live one.
  poppedOut?: boolean;
}

export default function Sidebar(props: Props) {
  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { guideMelodyVolume, setGuideMelodyVolume } = useGuideMelodyVolume();
  const { pianoRollOpacity, setPianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize, setPianoRollSize } = usePianoRollSize();
  const { queueIntermissionEnabled, setQueueIntermissionEnabled } =
    useQueueIntermissionEnabled();
  const { micOutputEnabled, setMicOutputEnabled } = useMicOutputEnabled();
  const { micRmsGateEnabled, setMicRmsGateEnabled } = useMicRmsGateEnabled();
  const { micRmsGateThreshold, setMicRmsGateThreshold } =
    useMicRmsGateThreshold();
  const { oledFriendly, setOledFriendly } = useOledFriendly();
  const { joysoundRomajiWordSegmentation, setJoysoundRomajiWordSegmentation } =
    useJoysoundRomajiWordSegmentation();
  const { breakEndsAt, setBreakEndsAt } = useBreakEndsAt();

  // Collapse the Settings section so the big screen shows only the Queue
  // during regular operation. Synced through the main process so the remocon
  // can toggle it on the TV remotely. The popped-out window exists *to* show
  // the settings, so it ignores the flag.
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();
  const settingsVisible = props.variant === "window" || !settingsCollapsed;

  // Break length is a per-screen choice; only the break itself is synced.
  const [breakMinutes, setBreakMinutes] = useState(5);
  const breakActive = breakEndsAt !== null;
  // Tick while a break is active so the End Break countdown stays live.
  // breakNow only refreshes here, so a stale value can otherwise sit around
  // between one break ending and the next starting; without the immediate
  // refresh below, a newly-started break's remaining time would briefly be
  // computed against that stale timestamp (jumping to an inflated value
  // before the first 1s tick corrects it).
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

  const serviceHealthCell = (available: boolean | undefined) => (
    <span className="serviceHealthIndicator">
      {props.isRecheckingServiceHealth ? (
        <span className="serviceHealthSpinner" />
      ) : available === false ? (
        "⚠️"
      ) : (
        "✅"
      )}
    </span>
  );

  return (
    <div
      className={`appSidebar grey lighten-3 ${
        props.variant === "window" ? "appSidebarWindow" : ""
      }`}
      style={props.style}
    >
      {props.onResizeHandleMouseDown && (
        <div
          className="sidebarResizeHandle"
          title="Drag to resize"
          onMouseDown={props.onResizeHandleMouseDown}
        />
      )}
      <QRCode hostname={props.hostname} oledFriendly={oledFriendly} />
      <nav className="center-align settingsHeader">
        <span
          className="settingsHeaderTitle"
          onClick={
            props.variant === "window"
              ? undefined
              : () => setSettingsCollapsed(!settingsCollapsed)
          }
        >
          <span>Settings</span>
          {props.variant === "window" ? null : settingsCollapsed ? (
            <FaChevronDown />
          ) : (
            <FaChevronUp />
          )}
        </span>
        {props.variant === "docked" && props.onPopOut && (
          <button
            className="settingsHeaderButton"
            title="Open the settings in their own window"
            onClick={props.onPopOut}
          >
            <FaExternalLinkAlt />
          </button>
        )}
        {props.variant === "window" && props.onDock && (
          <button
            className="settingsHeaderButton"
            title="Close this window and dock the settings back on the big screen"
            onClick={props.onDock}
          >
            <FaCompressAlt />
          </button>
        )}
      </nav>
      {props.poppedOut && props.variant === "docked" && (
        <div className="sidebarPoppedOutNotice center-align">
          Settings are open in their own window.
        </div>
      )}
      {settingsVisible && (
        <div className="section center-align">
          <HostnameSetting
            hostname={props.hostname}
            onChange={props.onHostnameChange}
          />
          <BackgroundMusicSetting selected={bgmTrack} onChange={setBgmTrack} />
          <div className="settingsGrid">
            <span className="settingSubheader">Volume</span>
            <span className="settingLabel">BGM</span>
            <span className="settingValue">{Math.round(bgmVolume * 100)}%</span>
            <span className="range-field settingControl">
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(bgmVolume * 100)}
                onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
              />
            </span>
            <span className="settingLabel">Guide</span>
            <span className="settingValue">
              {Math.round(guideMelodyVolume * 100)}%
            </span>
            <span className="range-field settingControl">
              <input
                type="range"
                min="0"
                max="150"
                value={Math.round(guideMelodyVolume * 100)}
                onChange={(e) =>
                  setGuideMelodyVolume(Number(e.target.value) / 100)
                }
              />
            </span>
            {/* Everything mic-related in one place: which channels are being
                listened to, whether they go to the speakers, and the gate
                that decides whether an idle mic draws on the piano roll. */}
            <span className="settingSubheader">Microphone</span>
            {props.mics.map((mic, i) => (
              // Positional: this list *is* mic 0, mic 1, ... and the same
              // device+channel can legitimately appear twice.
              <div className="settingFullRow" key={`mic-${i}`}>
                <MicrophoneSetting
                  mic={mic}
                  onChange={(name, channel) =>
                    props.onSelectMic(i, name, channel)
                  }
                />
              </div>
            ))}
            <div className="settingFullRow">
              <MicrophoneSetting
                mic={null}
                onChange={(name, channel) =>
                  props.onSelectMic(props.mics.length, name, channel)
                }
              />
            </div>
            <div className="settingFullRow">
              <button className="btn" onClick={props.onClearMics}>
                Clear mics
              </button>
            </div>
            <span
              className="settingLabel settingLabelClickable"
              title="Mix the mics into the room's speakers through the app. Off when a hardware mixer is doing it."
              onClick={() => setMicOutputEnabled(!micOutputEnabled)}
            >
              Software Echo
            </span>
            <div className="switch settingControlWide">
              <label>
                <input
                  type="checkbox"
                  checked={micOutputEnabled}
                  onChange={(e) => setMicOutputEnabled(e.target.checked)}
                />
                <span className="lever"></span>
              </label>
            </div>
            <span
              className="settingLabel settingLabelClickable"
              title="Use when a mixer's echo/reverb bleeds into the mic channels and idle mics ghost-draw the active singer's melody."
              onClick={() => setMicRmsGateEnabled(!micRmsGateEnabled)}
            >
              Pitch Gate
            </span>
            <div className="switch settingControlWide">
              <label>
                <input
                  type="checkbox"
                  checked={micRmsGateEnabled}
                  onChange={(e) => setMicRmsGateEnabled(e.target.checked)}
                />
                <span className="lever"></span>
              </label>
            </div>
            {micRmsGateEnabled && (
              <>
                <span
                  className="settingLabel"
                  title="Raise until the idle mic stops drawing, then stop — too high and it starts cutting quiet singing too."
                >
                  Gate Threshold
                </span>
                <span className="settingValue">
                  {Math.round(linearToDbfs(micRmsGateThreshold))} dB
                </span>
                <span className="range-field settingControl">
                  <input
                    type="range"
                    min={Math.round(linearToDbfs(MIN_MIC_RMS_GATE_THRESHOLD))}
                    max={Math.round(linearToDbfs(MAX_MIC_RMS_GATE_THRESHOLD))}
                    value={Math.round(linearToDbfs(micRmsGateThreshold))}
                    onChange={(e) =>
                      setMicRmsGateThreshold(
                        dbfsToLinear(Number(e.target.value)),
                      )
                    }
                  />
                </span>
                <span
                  className="settingLabel"
                  title="Live only while a scored song is playing — nothing polls the mics between songs."
                >
                  Mic Levels
                </span>
                <span className="settingControlWide">
                  <MicLevelMeters
                    micCount={props.mics.length}
                    micLevelsRef={props.micLevelsRef}
                    threshold={micRmsGateThreshold}
                  />
                </span>
              </>
            )}
            <span className="settingSubheader">Piano Roll</span>
            <span className="settingLabel">Opacity</span>
            <span className="settingValue">
              {Math.round(pianoRollOpacity * 100)}%
            </span>
            <span className="range-field settingControl">
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(pianoRollOpacity * 100)}
                onChange={(e) =>
                  setPianoRollOpacity(Number(e.target.value) / 100)
                }
              />
            </span>
            <span className="settingLabel">Size</span>
            <div className="pianoRollSizeButtons settingControlWide">
              {PIANO_ROLL_SIZE_PRESETS.map(({ label, size }) => (
                <button
                  key={label}
                  className={`btn-small ${
                    Math.abs(pianoRollSize - size) < 0.001 ? "" : "grey"
                  }`}
                  onClick={() => setPianoRollSize(size)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="settingSubheader">Options</span>
            <span
              className="settingLabel settingLabelClickable"
              onClick={() =>
                setQueueIntermissionEnabled(!queueIntermissionEnabled)
              }
            >
              Intermission
            </span>
            <div className="switch settingControlWide">
              <label>
                <input
                  type="checkbox"
                  checked={queueIntermissionEnabled}
                  onChange={(e) =>
                    setQueueIntermissionEnabled(e.target.checked)
                  }
                />
                <span className="lever"></span>
              </label>
            </div>
            <span className="settingLabel">Request Break</span>
            <div className="pianoRollSizeButtons breakButtons settingControlWide">
              <button
                className="btn-small grey"
                onClick={() =>
                  breakActive
                    ? setBreakEndsAt(
                        Math.max(breakEndsAt! - 60 * 1000, Date.now()),
                      )
                    : setBreakMinutes(Math.max(breakMinutes - 1, 1))
                }
              >
                −
              </button>
              <button
                className={
                  breakActive
                    ? "btn-small breakActionButton breakActionButtonActive"
                    : "btn-small breakActionButton"
                }
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
                className="btn-small grey"
                onClick={() =>
                  breakActive
                    ? setBreakEndsAt(breakEndsAt! + 60 * 1000)
                    : setBreakMinutes(breakMinutes + 1)
                }
              >
                +
              </button>
            </div>
            <span
              className="settingLabel settingLabelClickable"
              onClick={() => setOledFriendly(!oledFriendly)}
            >
              OLED Mode
            </span>
            <div className="switch settingControlWide">
              <label>
                <input
                  type="checkbox"
                  checked={oledFriendly}
                  onChange={(e) => setOledFriendly(e.target.checked)}
                />
                <span className="lever"></span>
              </label>
            </div>
            <span
              className="settingLabel settingLabelClickable"
              onClick={() =>
                setJoysoundRomajiWordSegmentation(
                  !joysoundRomajiWordSegmentation,
                )
              }
            >
              EZ Romaji
            </span>
            <div className="switch settingControlWide">
              <label>
                <input
                  type="checkbox"
                  checked={joysoundRomajiWordSegmentation}
                  onChange={(e) =>
                    setJoysoundRomajiWordSegmentation(e.target.checked)
                  }
                />
                <span className="lever"></span>
              </label>
            </div>
          </div>
          <table className="centered">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>DAM</td>
                <td>{serviceHealthCell(props.serviceHealth?.damAvailable)}</td>
              </tr>
              <tr>
                <td>Joysound</td>
                <td>
                  {serviceHealthCell(props.serviceHealth?.joysoundAvailable)}
                </td>
              </tr>
            </tbody>
          </table>
          <button
            className="btn"
            disabled={props.isRecheckingServiceHealth}
            onClick={props.onRecheckServiceHealth}
          >
            Check now
          </button>
          <button
            className="btn red"
            disabled={props.isClearingQueue}
            onClick={props.onClearQueue}
          >
            Clear Queue
          </button>
        </div>
      )}
      <nav className="center-align">Queue</nav>
      <Queue />
    </div>
  );
}
