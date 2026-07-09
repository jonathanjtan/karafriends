import M from "materialize-css";
import "materialize-css/dist/css/materialize.css"; // tslint:disable-line:no-submodule-imports
import React, { useEffect, useMemo, useRef, useState } from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaChevronDown, FaChevronUp } from "react-icons/fa";
import { fetchQuery, graphql, useMutation, useSubscription } from "react-relay";

import { HOSTNAME } from "../common/constants";
import environment from "../common/graphqlEnvironment";
import useBgmTrack from "../common/hooks/useBgmTrack";
import useBgmVolume from "../common/hooks/useBgmVolume";
import useGuideMelodyVolume from "../common/hooks/useGuideMelodyVolume";
import useSettingsCollapsed from "../common/hooks/useSettingsCollapsed";
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
import { AppQueueAddedSubscription } from "./__generated__/AppQueueAddedSubscription.graphql";
import { AppRecheckServiceHealthMutation } from "./__generated__/AppRecheckServiceHealthMutation.graphql";
import { AppServiceHealthQuery } from "./__generated__/AppServiceHealthQuery.graphql";

const OLED_FRIENDLY_STORAGE_KEY = "oledFriendly";
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
  const [hostname, setHostname] = useState(HOSTNAME);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const { bgmTrack, setBgmTrack } = useBgmTrack();
  const { bgmVolume, setBgmVolume } = useBgmVolume();
  const { guideMelodyVolume, setGuideMelodyVolume } = useGuideMelodyVolume();

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

  const [oledFriendly, _setOledFriendly] = useState<boolean>(
    () => localStorage.getItem(OLED_FRIENDLY_STORAGE_KEY) === "true",
  );

  // Collapse the Settings section so the big screen shows only the Queue
  // during regular operation. Synced through the main process so the remocon
  // can toggle it on the TV remotely.
  const { settingsCollapsed, setSettingsCollapsed } = useSettingsCollapsed();

  const setOledFriendly = (value: boolean) => {
    if (value) {
      localStorage.setItem(OLED_FRIENDLY_STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(OLED_FRIENDLY_STORAGE_KEY);
    }
    _setOledFriendly(value);
  };

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

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "q" || event.key === "Q") {
      setSidebarVisible(!sidebarVisible);
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
  }, [sidebarVisible]);

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
    <div className="appMainContainer black row">
      <div
        className={`appPlayer col ${
          sidebarVisible ? "s11" : "s12"
        } valign-wrapper`}
      >
        <Player mics={mics} kuroshiro={props.kuroshiro} audio={props.audio} />
        <Effects />
        <BackgroundMusic trackFilename={bgmTrack} volume={bgmVolume} />
      </div>
      {sidebarVisible && (
        <div className="appSidebar col s1 grey lighten-3">
          <QRCode hostname={hostname} />
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
                volume={bgmVolume}
                onVolumeChange={setBgmVolume}
              />
              <p>Guide Melody: {Math.round(guideMelodyVolume * 100)}%</p>
              <p className="range-field">
                <input
                  type="range"
                  min="0"
                  max="150"
                  value={Math.round(guideMelodyVolume * 100)}
                  onChange={(e) =>
                    setGuideMelodyVolume(Number(e.target.value) / 100)
                  }
                />
              </p>
              <div className="switch">
                <label>
                  OLED Mode
                  <input
                    type="checkbox"
                    checked={oledFriendly}
                    onChange={(e) => setOledFriendly(e.target.checked)}
                  />
                  <span className="lever"></span>
                </label>
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
            </div>
          )}
          <nav className="center-align">Queue</nav>
          <Queue />
        </div>
      )}
    </div>
  );
}

export default App;
