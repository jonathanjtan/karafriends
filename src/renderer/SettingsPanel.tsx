import "materialize-css/dist/css/materialize.css"; // tslint:disable-line:no-submodule-imports
import React, { useEffect, useRef, useState } from "react";
import { graphql, useMutation } from "react-relay";

import useOledFriendly from "../common/hooks/useOledFriendly";
import useServiceHealth from "../common/hooks/useServiceHealth";
import "./App.css";
import {
  closeSettingsPanelWindow,
  MicSelection,
  openQrPanelWindow,
  sendSettingsPanelMessage,
  subscribeSettingsPanelMessages,
} from "./settingsPanelBus";
import Sidebar from "./Sidebar";
import { SettingsPanelClearQueueMutation } from "./__generated__/SettingsPanelClearQueueMutation.graphql";

// Keep asking the big screen for a snapshot until one arrives — the panel is
// useless without one, and a single request lost to a reload on the other side
// would leave it stuck on the placeholder forever.
const OWNER_STATE_RETRY_INTERVAL_MS = 500;

const clearQueueMutation = graphql`
  mutation SettingsPanelClearQueueMutation {
    clearQueue
  }
`;

// Root of the popped-out settings window: the same <Sidebar>, filling its own
// window instead of a column beside the video. Every setting it shows is
// either a synced setting (owned by the main process, reached over GraphQL) or
// relayed from the big screen over the bus.
export default function SettingsPanel() {
  const [ownerState, setOwnerState] = useState<{
    mics: MicSelection[];
  } | null>(null);
  const micLevelsRef = useRef<number[]>([]);
  const { oledFriendly } = useOledFriendly();
  // No onTransition: the big screen already toasts service flips to the room.
  const { serviceHealth, isRechecking, recheck } = useServiceHealth();
  const [commitClearQueue, isClearingQueue] =
    useMutation<SettingsPanelClearQueueMutation>(clearQueueMutation);

  useEffect(() => {
    const unsubscribe = subscribeSettingsPanelMessages((message) => {
      switch (message.type) {
        case "ownerState":
          setOwnerState({ mics: message.mics });
          break;
        case "micLevels":
          micLevelsRef.current = message.levels;
          break;
      }
    });

    sendSettingsPanelMessage({ type: "panelOpened" });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (ownerState !== null) return;
    const interval = setInterval(
      () => sendSettingsPanelMessage({ type: "requestOwnerState" }),
      OWNER_STATE_RETRY_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [ownerState]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("oledFriendly", oledFriendly);
    return () => html.classList.remove("oledFriendly");
  }, [oledFriendly]);

  if (ownerState === null) {
    return (
      <div className="settingsPanelConnecting grey lighten-3">
        Connecting to the big screen…
      </div>
    );
  }

  return (
    <Sidebar
      variant="window"
      mics={ownerState.mics}
      onSelectMic={(index, name, channel) =>
        sendSettingsPanelMessage({ type: "setMic", index, name, channel })
      }
      onClearMics={() => sendSettingsPanelMessage({ type: "clearMics" })}
      micLevelsRef={micLevelsRef}
      serviceHealth={serviceHealth}
      isRecheckingServiceHealth={isRechecking}
      onRecheckServiceHealth={recheck}
      isClearingQueue={isClearingQueue}
      onClearQueue={() => {
        if (window.confirm("Clear the queue and skip the current song?")) {
          commitClearQueue({ variables: {} });
        }
      }}
      onDock={closeSettingsPanelWindow}
      onPopOutQr={openQrPanelWindow}
    />
  );
}
