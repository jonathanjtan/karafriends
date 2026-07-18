import M from "materialize-css";
import "materialize-css/dist/css/materialize.css"; // tslint:disable-line:no-submodule-imports
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FaChevronDown,
  FaChevronLeft,
  FaChevronRight,
  FaChevronUp,
} from "react-icons/fa"; // tslint:disable-line:no-submodule-imports
import { fetchQuery, graphql, useMutation, useSubscription } from "react-relay";

import { HOSTNAME } from "../common/constants";
import environment from "../common/graphqlEnvironment";
import useBgmTrack from "../common/hooks/useBgmTrack";
import useBgmVolume from "../common/hooks/useBgmVolume";
import useBreakEndsAt from "../common/hooks/useBreakEndsAt";
import useGuideMelodyVolume from "../common/hooks/useGuideMelodyVolume";
import useJoysoundRomajiWordSegmentation from "../common/hooks/useJoysoundRomajiWordSegmentation";
import useOledFriendly from "../common/hooks/useOledFriendly";
import usePianoRollOpacity from "../common/hooks/usePianoRollOpacity";
import usePianoRollSize from "../common/hooks/usePianoRollSize";
import useQueueIntermissionEnabled from "../common/hooks/useQueueIntermissionEnabled";
import useSettingsCollapsed from "../common/hooks/useSettingsCollapsed";
import useSidebarCollapsed from "../common/hooks/useSidebarCollapsed";
import { KuroshiroSingleton } from "../common/joysoundParser";
import "./App.css";
import BackgroundMusic from "./BackgroundMusic";
import BackgroundMusicSetting from "./BackgroundMusicSetting";
import Effects from "./Effects";
import HostnameSetting from "./HostnameSetting";
import MicrophoneSetting from "./MicrophoneSetting";
import { InputDevice } from "./nativeAudio";
import Player from "./Player";
import QRCode from "./QRCode";
import Queue from "./Queue";
import KarafriendsAudio from "./webAudio";
import { AppClearQueueMutation } from "./__generated__/AppClearQueueMutation.graphql";
import { AppQueueAddedSubscription } from "./__generated__/AppQueueAddedSubscription.graphql";
import { AppRecheckServiceHealthMutation } from "./__generated__/AppRecheckServiceHealthMutation.graphql";
import { AppServiceHealthQuery } from "./__generated__/AppServiceHealthQuery.graphql";

// OLED mode used to be renderer-local; it now lives in the main process
// (synced via useOledFriendly) so the remocon can toggle it too. The key only
// remains for the one-time migration below.
const LEGACY_OLED_FRIENDLY_STORAGE_KEY = "oledFriendly";
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 640;
// Mirror the remocon's Piano Roll Size presets so both surfaces match.
const PIANO_ROLL_SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "Off", size: 0 },
  { label: "S", size: 0.2 },
  { label: "M", size: 0.3 },
  { label: "L", size: 0.4 },
];
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

// Default the remocon address to a private LAN IPv4 (what a phone on the same
// WiFi can actually reach), with the remocon port so the QR is scannable
// out of the box. Fall back to the mDNS hostname if no LAN address is found.
function defaultHostname(): string {
  const { remoconPort } = window.karafriends.karafriendsConfig();
  const ipv4 = window.karafriends
    .ipAddresses()
    .filter((addr) => /^\d{1,3}(\.\d{1,3}){3}$/.test(addr));
  const preferred =
    ipv4.find((addr) => addr.startsWith("192.168.")) ??
    ipv4.find((addr) => addr.startsWith("10.")) ??
    ipv4.find((addr) => /^172\.(1[6-9]|2\d|3[01])\./.test(addr)) ??
    ipv4[0];
  return preferred ? `${preferred}:${remoconPort}` : HOSTNAME;
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

const serviceHealthQuery = graphql`
  query AppServiceHealthQuery {
    serviceHealth {
      damAvailable
      joysoundAvailable
      checkedAt
    }
  }
`;

const recheckServiceHealthMutation = graphql`
  mutation AppRecheckServiceHealthMutation {
    recheckServiceHealth {
      damAvailable
      joysoundAvailable
      checkedAt
    }
  }
`;

const clearQueueMutation = graphql`
  mutation AppClearQueueMutation {
    clearQueue
  }
`;

const SERVICE_HEALTH_POLL_INTERVAL_MS = 30 * 1000;

interface ServiceHealthState {
  damAvailable: boolean;
  joysoundAvailable: boolean;
  checkedAt: string;
}

function App(props: {
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const [mics, _setMics] = useState<InputDevice[]>([]);
  const [hostname, setHostname] = useState(defaultHostname);
  // Sidebar visibility is synced through the main process (like the Settings
  // section) so the remocon can fullscreen the TV's playing song remotely.
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarCollapsed();
  const sidebarVisible = !sidebarCollapsed;
  // The floating collapse/expand tab auto-hides; mouse movement reveals it.
  const [controlsVisible, setControlsVisible] = useState(false);
  // Canonical name of the BGM track currently audible, for the intermission
  // screen's "Now Playing" line.
  const [bgmNowPlaying, setBgmNowPlaying] = useState<string | null>(null);
  // Sidebar width is drag-resizable and persisted locally to each TV — it's a
  // display-fit preference, not a room-wide synced setting.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? Math.min(Math.max(stored, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH)
      : DEFAULT_SIDEBAR_WIDTH;
  });
  // Width changes from collapse/expand animate; drag-resize must not (a
  // transition would make the sidebar lag behind the cursor), so the
  // transition is suspended while a drag is in progress.
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const startSidebarResize = (event: React.MouseEvent) => {
    event.preventDefault();
    let latestWidth = sidebarWidth;
    setSidebarResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (moveEvent: MouseEvent) => {
      latestWidth = Math.min(
        Math.max(window.innerWidth - moveEvent.clientX, MIN_SIDEBAR_WIDTH),
        MAX_SIDEBAR_WIDTH,
      );
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
  const { pianoRollOpacity, setPianoRollOpacity } = usePianoRollOpacity();
  const { pianoRollSize, setPianoRollSize } = usePianoRollSize();
  const { queueIntermissionEnabled, setQueueIntermissionEnabled } =
    useQueueIntermissionEnabled();
  const { breakEndsAt, setBreakEndsAt } = useBreakEndsAt();
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

  const { oledFriendly, setOledFriendly } = useOledFriendly();
  const { joysoundRomajiWordSegmentation, setJoysoundRomajiWordSegmentation } =
    useJoysoundRomajiWordSegmentation();

  useEffect(() => {
    if (localStorage.getItem(LEGACY_OLED_FRIENDLY_STORAGE_KEY) === "true") {
      setOledFriendly(true);
    }
    localStorage.removeItem(LEGACY_OLED_FRIENDLY_STORAGE_KEY);
  }, []);

  // Collapse the Settings section so the big screen shows only the Queue
  // during regular operation. Synced through the main process so the remocon
  // can toggle it on the TV remotely.
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();

  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("oledFriendly", oledFriendly);
    return () => html.classList.remove("oledFriendly");
  }, [oledFriendly]);

  const [serviceHealth, setServiceHealth] = useState<ServiceHealthState | null>(
    null,
  );
  const wasServiceUnhealthyRef = useRef(false);

  const applyServiceHealth = (health: ServiceHealthState) => {
    setServiceHealth(health);

    const isUnhealthy = !health.damAvailable || !health.joysoundAvailable;

    if (isUnhealthy === wasServiceUnhealthyRef.current) return;
    wasServiceUnhealthyRef.current = isUnhealthy;

    if (isUnhealthy) {
      const unavailable = [
        !health.damAvailable && "DAM",
        !health.joysoundAvailable && "Joysound",
      ].filter((name): name is string => !!name);
      M.toast({
        html: `<span>⚠️ ${unavailable.join(" & ")} unreachable — try cycling your VPN and relaunching</span>`,
      });
    } else {
      M.toast({ html: "<span>✅ DAM & Joysound reachable again</span>" });
    }
  };

  // Polling Query.serviceHealth is just a fast local read of whatever the
  // main process last computed, not a real check in progress — only the
  // manual recheck mutation actually awaits a live check, so that's the
  // only case worth showing a spinner for.
  const [commitRecheckServiceHealth, isRecheckingServiceHealth] =
    useMutation<AppRecheckServiceHealthMutation>(recheckServiceHealthMutation);
  const [commitClearQueue, isClearingQueue] =
    useMutation<AppClearQueueMutation>(clearQueueMutation);

  useEffect(() => {
    const poll = () =>
      fetchQuery<AppServiceHealthQuery>(
        environment,
        serviceHealthQuery,
        {},
      ).subscribe({
        next: ({ serviceHealth: freshServiceHealth }) =>
          applyServiceHealth(freshServiceHealth),
      });

    poll();
    const interval = setInterval(poll, SERVICE_HEALTH_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const setMics = (newMics: InputDevice[]) => {
    const micsToSave = newMics.map((mic) => ({
      name: mic.name,
      channel: mic.channelSelection,
    }));
    localStorage.setItem("mics", JSON.stringify(micsToSave));
    _setMics(newMics);
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

  const onChangeMic = (index: number, newMic: InputDevice) => {
    const updatedMics = [...mics];
    const oldMic = updatedMics.splice(index, 1, newMic)[0];
    if (oldMic) oldMic.stop();
    setMics(updatedMics);
  };

  const clearMics = () => {
    mics.forEach((mic) => mic.stop());
    setMics([]);
  };

  return (
    <div className="appMainContainer black">
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
        <div
          className="appSidebar grey lighten-3"
          style={{ width: sidebarWidth }}
        >
          <div
            className="sidebarResizeHandle"
            title="Drag to resize"
            onMouseDown={startSidebarResize}
          />
          <QRCode hostname={hostname} oledFriendly={oledFriendly} />
          <nav
            className="center-align settingsHeader"
            onClick={() => setSettingsCollapsed(!settingsCollapsed)}
          >
            <span>Settings</span>
            {settingsCollapsed ? <FaChevronDown /> : <FaChevronUp />}
          </nav>
          {!settingsCollapsed && (
            <div className="section center-align">
              <HostnameSetting hostname={hostname} onChange={setHostname} />
              {mics.map((mic, i) => (
                <MicrophoneSetting
                  key={mic.deviceId}
                  onChange={onChangeMic.bind(null, i)}
                  mic={mic}
                />
              ))}
              <MicrophoneSetting
                onChange={onChangeMic.bind(null, mics.length)}
                mic={null}
              />
              <button className="btn" onClick={clearMics}>
                Clear mics
              </button>
              <BackgroundMusicSetting
                selected={bgmTrack}
                onChange={setBgmTrack}
              />
              <div className="settingsGrid">
                <span className="settingSubheader">Volume</span>
                <span className="settingLabel">BGM</span>
                <span className="settingValue">
                  {Math.round(bgmVolume * 100)}%
                </span>
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
                    <td>
                      <span className="serviceHealthIndicator">
                        {isRecheckingServiceHealth ? (
                          <span className="serviceHealthSpinner" />
                        ) : serviceHealth?.damAvailable === false ? (
                          "⚠️"
                        ) : (
                          "✅"
                        )}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td>Joysound</td>
                    <td>
                      <span className="serviceHealthIndicator">
                        {isRecheckingServiceHealth ? (
                          <span className="serviceHealthSpinner" />
                        ) : serviceHealth?.joysoundAvailable === false ? (
                          "⚠️"
                        ) : (
                          "✅"
                        )}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <button
                className="btn"
                disabled={isRecheckingServiceHealth}
                onClick={() =>
                  commitRecheckServiceHealth({
                    variables: {},
                    onCompleted: ({ recheckServiceHealth }) =>
                      applyServiceHealth(recheckServiceHealth),
                  })
                }
              >
                Check now
              </button>
              <button
                className="btn red"
                disabled={isClearingQueue}
                onClick={() => {
                  if (
                    window.confirm("Clear the queue and skip the current song?")
                  ) {
                    commitClearQueue({ variables: {} });
                  }
                }}
              >
                Clear Queue
              </button>
            </div>
          )}
          <nav className="center-align">Queue</nav>
          <Queue />
        </div>
      </div>
    </div>
  );
}

export default App;
