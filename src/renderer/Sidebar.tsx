import React from "react";
import {
  FaChevronDown,
  FaChevronUp,
  FaCompressAlt,
  FaExternalLinkAlt,
} from "react-icons/fa"; // tslint:disable-line:no-submodule-imports

import useHostname from "../common/hooks/useHostname";
import useOledFriendly from "../common/hooks/useOledFriendly";
import { ServiceHealthState } from "../common/hooks/useServiceHealth";
import useSettingsCollapsed from "../common/hooks/useSettingsCollapsed";
import {
  SECTIONS,
  SettingsActions,
  settingsForSurface,
  useRoomSettings,
} from "../common/settings";
import HostnameSetting from "./HostnameSetting";
import MicLevelMeters from "./MicLevelMeters";
import MicrophoneSetting from "./MicrophoneSetting";
import QRCode from "./QRCode";
import Queue from "./Queue";
import SettingRow from "./SettingRow";
import { MicSelection } from "./settingsPanelBus";

const DEFAULT_BREAK_MESSAGE = "⚠️ Don't forget to stay hydrated!";

interface Props {
  // "docked" is the column beside the video in the big-screen window;
  // "window" is the popped-out settings window, which fills its own window
  // and can't be collapsed or resized by the drag handle.
  variant: "docked" | "window";
  // The mics belong to the big screen's renderer process (see
  // settingsPanelBus.ts), so they arrive as props and changes go back out as
  // callbacks — in the popped-out window those callbacks travel over the bus.
  // Everything else in here is a synced setting the sidebar reads itself.
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
  // Docked: open the QR in its own window, to park on a second display.
  onPopOutQr?: () => void;
  // True while the settings window is open, so the docked sidebar can say so
  // instead of pretending its (hidden) copy is the live one.
  poppedOut?: boolean;
}

export default function Sidebar(props: Props) {
  const settings = useRoomSettings();
  const { oledFriendly } = useOledFriendly();
  const { hostname } = useHostname();

  // Collapse the Settings section so the big screen shows only the Queue
  // during regular operation. Synced through the main process so the remocon
  // can toggle it on the TV remotely. The popped-out window exists *to* show
  // the settings, so it ignores the flag.
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();
  const settingsVisible = props.variant === "window" || !settingsCollapsed;

  const actions: SettingsActions = {
    editBreakMessage: {
      run: () => {
        const input = window.prompt("Break message:", DEFAULT_BREAK_MESSAGE);
        if (input === null) return;
        const trimmed = input.trim();
        if (trimmed === "") return;
        // No nickname on the big screen — the message shows unattributed.
        settings.setBreakMessage(trimmed, null);
      },
    },
    recheckServices: {
      run: props.onRecheckServiceHealth,
      disabled: props.isRecheckingServiceHealth,
    },
    clearQueue: { run: props.onClearQueue, disabled: props.isClearingQueue },
  };

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

  // Rows the manifest can't describe, because they aren't synced settings:
  // the mics live in this process, and service health is a live probe rather
  // than something you set. They render inside their section's grid.
  const sectionExtras: Partial<
    Record<(typeof SECTIONS)[number]["id"], React.ReactNode>
  > = {
    // Which of this machine's addresses the QR advertises.
    connection: (
      <div className="settingFullRow">
        <HostnameSetting />
      </div>
    ),
    microphone: (
      <>
        {props.mics.map((mic, i) => (
          // Positional: this list *is* mic 0, mic 1, ... and the same
          // device+channel can legitimately appear twice.
          <div className="settingFullRow" key={`mic-${i}`}>
            <MicrophoneSetting
              mic={mic}
              onChange={(name, channel) => props.onSelectMic(i, name, channel)}
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
      </>
    ),
    services: (
      <>
        {/* .settingValue rather than .settingControlWide so the indicator
            stays beside its label in the narrow layout too, where wide
            controls drop onto their own line. */}
        <span className="settingLabel">DAM</span>
        <span className="settingValue">
          {serviceHealthCell(props.serviceHealth?.damAvailable)}
        </span>
        <span className="settingLabel">Joysound</span>
        <span className="settingValue">
          {serviceHealthCell(props.serviceHealth?.joysoundAvailable)}
        </span>
      </>
    ),
  };

  // Mic level meters sit under Gate Threshold, so they trail the section's
  // manifest rows rather than leading them.
  const sectionTrailers: Partial<
    Record<(typeof SECTIONS)[number]["id"], React.ReactNode>
  > = {
    microphone: settings.micRmsGateEnabled.value ? (
      <>
        <span className="settingLabel">Mic Levels</span>
        <span className="settingControlWide">
          <MicLevelMeters
            micCount={props.mics.length}
            micLevelsRef={props.micLevelsRef}
            threshold={settings.micRmsGateThreshold.value}
          />
        </span>
        <span className="settingHint">
          Live only while a scored song is playing — nothing polls the mics
          between songs.
        </span>
      </>
    ) : null,
  };

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
      <div className="sidebarQrBlock">
        <QRCode hostname={hostname} oledFriendly={oledFriendly} />
        {props.variant === "docked" && props.onPopOutQr && (
          <button
            className="sidebarQrPopOut"
            title="Open the QR code in its own window, to leave on a second screen"
            onClick={props.onPopOutQr}
          >
            <FaExternalLinkAlt />
          </button>
        )}
      </div>
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
          <div className="settingsGrid">
            {SECTIONS.map((section) => {
              const defs = settingsForSurface("tv", section.id, settings);
              const extras = sectionExtras[section.id];
              const trailer = sectionTrailers[section.id];
              if (defs.length === 0 && !extras && !trailer) return null;
              return (
                <React.Fragment key={section.id}>
                  <span className="settingSubheader">{section.label}</span>
                  {extras}
                  {defs.map((def) => (
                    <SettingRow
                      key={def.label}
                      def={def}
                      settings={settings}
                      actions={actions}
                    />
                  ))}
                  {trailer}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
      <nav className="center-align">Queue</nav>
      <Queue />
    </div>
  );
}
