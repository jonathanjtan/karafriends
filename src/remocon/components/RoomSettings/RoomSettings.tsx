import classnames from "classnames";
import React from "react";
import { graphql, useMutation } from "react-relay";
import { Link } from "react-router";

import useServiceHealth from "../../../common/hooks/useServiceHealth";
import {
  SECTIONS,
  SettingsActions,
  settingsForSurface,
  useRoomSettings,
} from "../../../common/settings";
import useConfig from "../../hooks/useConfig";
import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./RoomSettings.module.scss";
import SettingRow from "./SettingRow";
import { RoomSettingsClearQueueMutation } from "./__generated__/RoomSettingsClearQueueMutation.graphql";

const clearQueueMutation = graphql`
  mutation RoomSettingsClearQueueMutation {
    clearQueue
  }
`;

const DEFAULT_BREAK_MESSAGE = "⚠️ Don't forget to stay hydrated!";

// The phone's settings drawer. Every row comes from the shared manifest
// (common/settings), so this file is styling and the handful of remocon-only
// concerns — supervised mode, and attributing a break message to whoever set
// it. The big screen renders the same manifest through renderer/Sidebar.
const RoomSettings = ({ onNavigate }: { onNavigate?: () => void }) => {
  const settings = useRoomSettings();
  const { serviceHealth, isRechecking, recheck } = useServiceHealth();
  const [commitClearQueue, isClearingQueue] =
    useMutation<RoomSettingsClearQueueMutation>(clearQueueMutation);

  const config = useConfig();
  const identity = useUserIdentity();

  // Room-wide settings affect everyone; in supervised mode only admins get to
  // touch them (same policy as playback controls).
  const disabled =
    config !== undefined &&
    config.supervisedMode === true &&
    !config.adminNicks.includes(identity.nickname) &&
    !config.adminDeviceIds.includes(identity.deviceId);

  const actions: SettingsActions = {
    editBreakMessage: {
      run: () => {
        const input = window.prompt("Break message:", DEFAULT_BREAK_MESSAGE);
        if (input === null) return;
        const trimmed = input.trim();
        if (trimmed === "") return;
        settings.setBreakMessage(trimmed, identity.nickname || null);
      },
    },
    recheckServices: { run: recheck, disabled: isRechecking },
    clearQueue: {
      run: () => {
        if (window.confirm("Clear the queue and skip the current song?")) {
          commitClearQueue({ variables: {} });
        }
      },
      disabled: isClearingQueue,
    },
  };

  const healthIcon = (available: boolean | undefined) => {
    if (isRechecking) return <span className={styles.healthSpinner} />;
    return available === false ? "⚠️" : "✅";
  };

  // Service health is a live probe, not a setting, so it isn't in the
  // manifest — it leads the Services section on both surfaces.
  const sectionExtras: Partial<
    Record<(typeof SECTIONS)[number]["id"], React.ReactNode>
  > = {
    // The TV fills this section with its interface picker; a phone already
    // knows a working address — its own — so it offers to hand it on.
    connection: (
      <div className={styles.row}>
        {/* Closing the drawer is the whole point: it covers the page, so
            navigating under it looks like the button did nothing. */}
        <Link className={styles.linkButton} to="/join" onClick={onNavigate}>
          Show Join QR
        </Link>
        <div className={styles.hint}>
          A code someone else can scan to open the remocon on their phone.
        </div>
      </div>
    ),
    services: (
      <div className={styles.row}>
        <div className={styles.healthRow}>
          <span>DAM</span>
          <span>{healthIcon(serviceHealth?.damAvailable)}</span>
        </div>
        <div className={styles.healthRow}>
          <span>Joysound</span>
          <span>{healthIcon(serviceHealth?.joysoundAvailable)}</span>
        </div>
      </div>
    ),
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Settings</span>
      </div>
      <div className={classnames(styles.body, { [styles.disabled]: disabled })}>
        {SECTIONS.map((section) => {
          const defs = settingsForSurface("remocon", section.id, settings);
          const extras = sectionExtras[section.id];
          if (defs.length === 0 && !extras) return null;
          return (
            <React.Fragment key={section.id}>
              <div className={styles.sectionHeader}>{section.label}</div>
              {extras}
              {defs.map((def) => (
                <SettingRow
                  key={def.label}
                  def={def}
                  settings={settings}
                  actions={actions}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default RoomSettings;
