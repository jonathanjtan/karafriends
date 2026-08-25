import M from "materialize-css";
import "materialize-css/dist/css/materialize.css"; // tslint:disable-line:no-submodule-imports
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa"; // tslint:disable-line:no-submodule-imports
import { graphql, useMutation, useSubscription } from "react-relay";

import useBgmTrack from "../common/hooks/useBgmTrack";
import useBgmVolume from "../common/hooks/useBgmVolume";
import useGuideMelodyVolume from "../common/hooks/useGuideMelodyVolume";
import useHistoryRecordingEnabled from "../common/hooks/useHistoryRecordingEnabled";
import useHostname from "../common/hooks/useHostname";
import useMicOutputEnabled from "../common/hooks/useMicOutputEnabled";
import useOledFriendly from "../common/hooks/useOledFriendly";
import useServiceHealth from "../common/hooks/useServiceHealth";
import useSidebarCollapsed from "../common/hooks/useSidebarCollapsed";
import { KuroshiroSingleton } from "../common/joysoundParser";
import "./App.css";
import BackgroundMusic from "./BackgroundMusic";
import Effects from "./Effects";
import { InputDevice } from "./nativeAudio";
import Player from "./Player";
import {
  MicSelection,
  openQrPanelWindow,
  openSettingsPanelWindow,
  sendSettingsPanelMessage,
  subscribeSettingsPanelMessages,
} from "./settingsPanelBus";
import Sidebar from "./Sidebar";
import KarafriendsAudio from "./webAudio";
import { AppClearQueueMutation } from "./__generated__/AppClearQueueMutation.graphql";
import { AppQueueAddedSubscription } from "./__generated__/AppQueueAddedSubscription.graphql";

// OLED mode used to be renderer-local; it now lives in the main process
// (synced via useOledFriendly) so the remocon can toggle it too. The key only
// remains for the one-time migration below.
const LEGACY_OLED_FRIENDLY_STORAGE_KEY = "oledFriendly";
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 640;
// However narrow the window gets, leave this much of it for the video. Without
// it a shrunk window ends up narrower than the sidebar, which then hangs off
// the right edge with its controls clipped.
const MIN_PLAYER_WIDTH = 200;
// How often the big screen ships mic levels to the popped-out window. The
// meters do their own attack/release smoothing on top, so this only has to be
// fast enough to look continuous.
const MIC_LEVEL_PUBLISH_INTERVAL_MS = 66;
// Volumes and the BGM track used to be renderer-local; they now live in the
// main process (synced via useBgmVolume/useGuideMelodyVolume/useBgmTrack) so
// the remocon can control them too. These keys only remain for the one-time
// migration below.
const LEGACY_BGM_TRACK_STORAGE_KEY = "bgmTrack";
const LEGACY_BGM_VOLUME_STORAGE_KEY = "bgmVolume";
const LEGACY_GUIDE_MELODY_VOLUME_STORAGE_KEY = "guideMelodyVolume";

interface SavedMic {
  name: string;
  channel: number;
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    Math.max(width, MIN_SIDEBAR_WIDTH),
    MAX_SIDEBAR_WIDTH,
    Math.max(window.innerWidth - MIN_PLAYER_WIDTH, MIN_SIDEBAR_WIDTH),
  );
}

const songAddedSubscription = graphql`
  subscription AppQueueAddedSubscription {
    queueAdded {
      ... on QueueItemInterface {
        name
        artistName
      }
    }
  }
`;

const clearQueueMutation = graphql`
  mutation AppClearQueueMutation {
    clearQueue
  }
`;

function App(props: {
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const [mics, _setMics] = useState<InputDevice[]>([]);
  // Latest RMS per mic, written by PianoRoll's pitch poller and read by the
  // settings-panel meters. A ref so 40Hz-per-mic updates never re-render App.
  const micLevelsRef = useRef<number[]>([]);
  // The address the QR codes encode. A synced setting, so the popped-out
  // settings window and the QR window read it straight from the main process.
  const { hostname } = useHostname();
  // Drives the "History off" marker below. Off is the default under `run-dev`,
  // so during development this is the normal state and the marker doubles as a
  // reminder of which build is on screen.
  const { historyRecordingEnabled } = useHistoryRecordingEnabled();
  // Sidebar visibility is synced through the main process (like the Settings
  // section) so the remocon can fullscreen the TV's playing song remotely.
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarCollapsed();
  const sidebarVisible = !sidebarCollapsed;
  // The floating collapse/expand tab auto-hides; mouse movement reveals it.
  const [controlsVisible, setControlsVisible] = useState(false);
  // True while the sidebar is detached into its own window. The docked copy
  // stays collapsed for as long as it is.
  const [settingsPoppedOut, setSettingsPoppedOut] = useState(false);
  // Canonical name of the BGM track currently audible, for the intermission
  // screen's "Now Playing" line.
  const [bgmNowPlaying, setBgmNowPlaying] = useState<string | null>(null);
  // Sidebar width is drag-resizable and persisted locally to each TV. It's a
  // display-fit preference, not a room-wide synced setting.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return clampSidebarWidth(
      Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH,
    );
  });
  // Width changes from collapse/expand animate; drag-resize must not (a
  // transition would make the sidebar lag behind the cursor), so the
  // transition is suspended while a drag is in progress.
  const [sidebarResizing, setSidebarResizing] = useState(false);

  // Shrinking the window re-clamps the sidebar (the stored width is kept, so
  // widening the window restores it).
  useEffect(() => {
    const onResize = () => setSidebarWidth(clampSidebarWidth(sidebarWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarWidth]);

  const startSidebarResize = (event: React.MouseEvent) => {
    event.preventDefault();
    let latestWidth = sidebarWidth;
    setSidebarResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (moveEvent: MouseEvent) => {
      latestWidth = clampSidebarWidth(window.innerWidth - moveEvent.clientX);
      setSidebarWidth(latestWidth);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidebarResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(latestWidth));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { guideMelodyVolume, setGuideMelodyVolume } = useGuideMelodyVolume();
  const { micOutputEnabled } = useMicOutputEnabled();
  const { oledFriendly, setOledFriendly } = useOledFriendly();

  useEffect(() => {
    const storedBgmVolume = localStorage.getItem(LEGACY_BGM_VOLUME_STORAGE_KEY);
    if (storedBgmVolume !== null) {
      if (Number.isFinite(Number(storedBgmVolume))) {
        setBgmVolume(Number(storedBgmVolume));
      }
      localStorage.removeItem(LEGACY_BGM_VOLUME_STORAGE_KEY);
    }

    const storedGuideMelodyVolume = localStorage.getItem(
      LEGACY_GUIDE_MELODY_VOLUME_STORAGE_KEY,
    );
    if (storedGuideMelodyVolume !== null) {
      if (Number.isFinite(Number(storedGuideMelodyVolume))) {
        setGuideMelodyVolume(Number(storedGuideMelodyVolume));
      }
      localStorage.removeItem(LEGACY_GUIDE_MELODY_VOLUME_STORAGE_KEY);
    }

    const storedBgmTrack = localStorage.getItem(LEGACY_BGM_TRACK_STORAGE_KEY);
    if (storedBgmTrack !== null) {
      setBgmTrack(storedBgmTrack);
      localStorage.removeItem(LEGACY_BGM_TRACK_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    props.audio.guideMelodyGain(guideMelodyVolume);
  }, [props.audio, guideMelodyVolume]);

  // Newly created InputDevices start out with output enabled (the native default), so
  // this has to re-run when the mic list changes too. Otherwise picking a mic
  // while muted would put it straight into the speakers.
  useEffect(() => {
    mics.forEach((mic) => mic.setMicOutputEnabled(micOutputEnabled));
  }, [mics, micOutputEnabled]);

  useEffect(() => {
    if (localStorage.getItem(LEGACY_OLED_FRIENDLY_STORAGE_KEY) === "true") {
      setOledFriendly(true);
    }
    localStorage.removeItem(LEGACY_OLED_FRIENDLY_STORAGE_KEY);
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("oledFriendly", oledFriendly);
    return () => html.classList.remove("oledFriendly");
  }, [oledFriendly]);

  // The big screen is the surface that warns the room about a service
  // dropping out, so it's the one that toasts.
  const { serviceHealth, isRechecking, recheck } = useServiceHealth({
    onTransition: (health, unhealthy) => {
      if (!unhealthy) {
        M.toast({ html: "<span>✅ DAM & Joysound reachable again</span>" });
        return;
      }

      const unavailable = [
        !health.damAvailable && "DAM",
        !health.joysoundAvailable && "Joysound",
      ].filter((name): name is string => !!name);
      M.toast({
        html: `<span>⚠️ ${unavailable.join(" & ")} unreachable. Try cycling your VPN and relaunching</span>`,
      });
    },
  });
  const [commitClearQueue, isClearingQueue] =
    useMutation<AppClearQueueMutation>(clearQueueMutation);

  const setMics = (newMics: InputDevice[]) => {
    const micsToSave = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
    }));
    localStorage.setItem("mics", JSON.stringify(micsToSave));
    _setMics(newMics);
  };

  const micSelections: MicSelection[] = mics.map((mic) => ({
    name: mic.name,
    channel: mic.channelSelection,
  }));

  const selectMic = (index: number, name: string, channel: number) => {
    const updatedMics = [...mics];
    const oldMic = updatedMics.splice(
      index,
      1,
      new InputDevice(name, channel),
    )[0];
    if (oldMic) oldMic.stop();
    setMics(updatedMics);
  };

  const clearMics = () => {
    mics.forEach((mic) => mic.stop());
    setMics([]);
  };

  // Reveal the floating sidebar toggle on mouse movement, then fade it back
  // out after a few idle seconds so it doesn't sit on top of a fullscreened
  // song. The tab stays interactive while hovered (handled in CSS).
  useEffect(() => {
    let hideTimeout: ReturnType<typeof setTimeout> | undefined;
    const revealControls = () => {
      setControlsVisible(true);
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => setControlsVisible(false), 3000);
    };

    window.addEventListener("mousemove", revealControls);

    return () => {
      window.removeEventListener("mousemove", revealControls);
      if (hideTimeout) clearTimeout(hideTimeout);
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "q" || event.key === "Q") {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);

    const savedMicInfo = JSON.parse(localStorage.getItem("mics") || "[]");
    const inputDevices = window.karafriends.nativeAudio.inputDevices();
    const channelCounts: { [key: string]: number } = inputDevices.reduce(
      (acc, cur) => ({
        ...acc,
        [cur[0]]: cur[1],
      }),
      {},
    );

    const savedMics = savedMicInfo
      .filter(
        ({ name, channel }: SavedMic) =>
          name in channelCounts && channel < channelCounts[name],
      )
      .map(({ name, channel }: SavedMic) => new InputDevice(name, channel));

    setMics(savedMics);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sidebarCollapsed]);

  // The popped-out settings window can't own the mics (see
  // settingsPanelBus.ts), so this window answers its intents and keeps it
  // supplied with snapshots. Re-subscribing whenever the owned state changes
  // keeps the handlers free of stale closures.
  useEffect(() => {
    const publishOwnerState = () =>
      sendSettingsPanelMessage({
        type: "ownerState",
        mics: micSelections,
      });

    const unsubscribe = subscribeSettingsPanelMessages((message) => {
      switch (message.type) {
        case "panelOpened":
          setSettingsPoppedOut(true);
          // Hand the whole screen to the video: the settings live in the
          // other window now.
          setSidebarCollapsed(true);
          publishOwnerState();
          break;
        case "panelClosed":
          setSettingsPoppedOut(false);
          setSidebarCollapsed(false);
          break;
        case "requestOwnerState":
          publishOwnerState();
          break;
        case "setMic":
          selectMic(message.index, message.name, message.channel);
          break;
        case "clearMics":
          clearMics();
          break;
      }
    });

    if (settingsPoppedOut) publishOwnerState();

    return unsubscribe;
  }, [mics, settingsPoppedOut]);

  // Mic levels are only published while somebody is looking at them.
  useEffect(() => {
    if (!settingsPoppedOut) return;
    const interval = setInterval(
      () =>
        sendSettingsPanelMessage({
          type: "micLevels",
          levels: micLevelsRef.current.slice(0, mics.length),
        }),
      MIC_LEVEL_PUBLISH_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [settingsPoppedOut, mics.length]);

  useSubscription<AppQueueAddedSubscription>(
    useMemo(
      () => ({
        variables: {},
        subscription: songAddedSubscription,
        onNext: (response) => {
          if (response)
            M.toast({
              html: `<h3>${response.queueAdded.name} - ${response.queueAdded.artistName}</h3>`,
            });
        },
      }),
      [songAddedSubscription],
    ),
  );

  return (
    <div className="appMainContainer black">
      {/* Persistent rather than a toast: the risk this guards against is a
          party running for three hours with recording off, and a notice that
          disappears is exactly the one nobody sees. Only the off state shows
          anything, since recording is the normal case and needs no chrome. */}
      {historyRecordingEnabled ? null : (
        <div
          className="appNotRecording"
          title="Played songs are not being logged to the history"
        >
          History off
        </div>
      )}
      <div
        className={`sidebarToggle ${controlsVisible ? "visible" : ""}`}
        style={{ right: sidebarVisible ? sidebarWidth : 0 }}
        title={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      >
        {sidebarVisible ? <FaChevronRight /> : <FaChevronLeft />}
      </div>
      <div className="appPlayer valign-wrapper">
        <Player
          mics={mics}
          micLevelsRef={micLevelsRef}
          kuroshiro={props.kuroshiro}
          audio={props.audio}
          hostname={hostname}
          bgmNowPlaying={bgmNowPlaying}
        />
        <Effects />
        <BackgroundMusic
          trackFilename={bgmTrack}
          volume={bgmVolume}
          onNowPlayingChange={setBgmNowPlaying}
        />
      </div>
      {/* Stays mounted while collapsed so the width can animate shut; the
          inner sidebar keeps its full width so the content doesn't reflow
          mid-transition, it just slides out of the clipped container. */}
      <div
        className={`appSidebarContainer ${sidebarVisible ? "" : "collapsed"} ${
          sidebarResizing ? "resizing" : ""
        }`}
        style={{ width: sidebarVisible ? sidebarWidth : 0 }}
      >
        <Sidebar
          variant="docked"
          style={{ width: sidebarWidth }}
          onResizeHandleMouseDown={startSidebarResize}
          mics={micSelections}
          onSelectMic={selectMic}
          onClearMics={clearMics}
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
          onPopOut={openSettingsPanelWindow}
          onPopOutQr={openQrPanelWindow}
          poppedOut={settingsPoppedOut}
        />
      </div>
    </div>
  );
}

export default App;
