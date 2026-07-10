import invariant from "ts-invariant";

import Hls from "hls.js";
import M from "materialize-css";

import React, { useEffect, useRef, useState } from "react";
import { commitMutation, fetchQuery, graphql } from "react-relay";
import YoutubePlayer from "youtube-player";
import { PlayerPopSongMutation } from "./__generated__/PlayerPopSongMutation.graphql";

import environment from "../common/graphqlEnvironment";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import useQueue from "../common/hooks/useQueue";
import useQueueIntermissionEnabled from "../common/hooks/useQueueIntermissionEnabled";
import { KuroshiroSingleton } from "../common/joysoundParser";
import AdhocLyrics from "./AdhocLyrics";
import DamGuideMelodySynth from "./damGuideMelody";
import JoysoundRenderer from "./JoysoundRenderer";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import QueueIntermission from "./QueueIntermission";
import KarafriendsAudio from "./webAudio";

const popSongMutation = graphql`
  mutation PlayerPopSongMutation {
    popSong {
      ... on DamQueueItem {
        __typename
        songId
        streamingUrls {
          url
        }
        scoringData
        timestamp
        streamingUrlIdx
        name
        artistName
      }
      ... on JoysoundQueueItem {
        __typename
        songId
        timestamp
        name
        artistName
        isRomaji
        youtubeVideoId
        scoringData
      }
      ... on YoutubeQueueItem {
        __typename
        songId
        timestamp
        hasAdhocLyrics
        hasCaptions
        gainValue
        name
      }
      ... on NicoQueueItem {
        __typename
        songId
        timestamp
        name
      }
    }
  }
`;

const POLL_INTERVAL_MS = 5 * 1000;
// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const NON_DAM_GAIN = 0.8;
const MAX_HLS_FATAL_ERROR_RETRIES = 2;
// How long the between-songs queue screen stays up before the next song
// starts (when queueIntermissionEnabled is on).
const QUEUE_INTERMISSION_MS = 5 * 1000;

function Player(props: {
  mics: InputDevice[];
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
  hostname: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const [scoringData, setScoringData] = useState<readonly number[]>([]);

  const [joysoundTelop, setJoysoundTelop] = useState<ArrayBuffer | null>(null);
  const [shouldShowJoysound, setShouldShowJoysound] = useState<boolean>(false);
  const [joysoundIsRomaji, setJoysoundIsRomaji] = useState<boolean>(false);

  const [shouldShowPianoRoll, setShouldShowPianoRoll] = useState<boolean>(true);
  const [shouldShowAdhocLyrics, setShouldShowAdhocLyrics] =
    useState<boolean>(false);
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Between-songs queue screen. The onended/pollQueue closures are wired up
  // once on mount, so they read the live setting and queue length through
  // refs rather than captured state.
  const queue = useQueue();
  const { queueIntermissionEnabled } = useQueueIntermissionEnabled();
  const [intermissionVisible, setIntermissionVisible] = useState(false);
  const intermissionEnabledRef = useRef(queueIntermissionEnabled);
  const queueLengthRef = useRef(queue.length);
  const intermissionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollQueueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    intermissionEnabledRef.current = queueIntermissionEnabled;
  }, [queueIntermissionEnabled]);

  useEffect(() => {
    queueLengthRef.current = queue.length;
  }, [queue]);

  const cancelIntermission = () => {
    if (intermissionTimerRef.current) {
      clearTimeout(intermissionTimerRef.current);
      intermissionTimerRef.current = null;
    }
    setIntermissionVisible(false);
  };

  useEffect(() => {
    if (queueIntermissionEnabled) return;
    // Setting turned off mid-intermission: if the next song was pending on
    // the timer, start it now; if the idle screen was up, just hide it.
    const timerWasPending = intermissionTimerRef.current !== null;
    cancelIntermission();
    if (timerWasPending) pollQueueRef.current?.();
  }, [queueIntermissionEnabled]);

  const audioCtx = useRef<AudioContext | null>(null);
  const videoAudioSrc = useRef<MediaElementAudioSourceNode | null>(null);
  const damGuideSynthRef = useRef<DamGuideMelodySynth | null>(null);

  let hls: Hls | null = null;

  useEffect(() => {
    if (!videoRef.current) return;

    const pollQueue = () =>
      commitMutation<PlayerPopSongMutation>(environment, {
        mutation: popSongMutation,
        variables: {},
        onCompleted: ({ popSong }) => {
          if (!videoRef.current) return;

          if (!popSong) {
            setPlaybackState("WAITING");
            pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
            return;
          }

          // A song is actually starting; take down the intermission screen
          // (it stays up through empty-queue polls as the idle screen).
          setIntermissionVisible(false);

          if (trackRef?.current) {
            trackRef.current.default = false;
            trackRef.current.src = "";
          }

          setPitchShiftSemis(0);

          if (hls) hls.destroy();

          if (damGuideSynthRef.current) {
            damGuideSynthRef.current.dispose();
            damGuideSynthRef.current = null;
          }

          switch (popSong.__typename) {
            case "DamQueueItem":
              if (!popSong.streamingUrls || !popSong.scoringData) {
                console.error(
                  `DAM data unavailable for song ${popSong.songId}, skipping`,
                );
                M.toast({
                  html: `<span>Skipped "${popSong.name}" — DAM unreachable</span>`,
                });
                pollQueue();
                return;
              }

              const { streamingUrls } = popSong;

              setShouldShowPianoRoll(true);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(false);
              setScoringData(popSong.scoringData);

              // DAM streams carry no audible guide melody; synthesize one
              // from the scoring notes, at the shared guide melody volume.
              damGuideSynthRef.current = new DamGuideMelodySynth(
                props.audio.audioContext,
                props.audio.guideMelodySynthSink(),
                videoRef.current,
                popSong.scoringData,
              );

              // If caching is on this means we'll be serving almost everything through /static
              // which seems kind of stupid, but whatever
              const fileUrl = `karafriends://${popSong.songId}-${popSong.streamingUrlIdx}.mp4`;

              let hlsFatalErrorRetries = 0;

              const loadRemote = () => {
                if (!videoRef.current) return;

                hls = new Hls({ maxBufferLength: 90 /* seconds */ });
                hls.attachMedia(videoRef.current);
                hls.loadSource(streamingUrls[popSong.streamingUrlIdx].url);

                hls.on(Hls.Events.ERROR, (_event, data) => {
                  if (!data.fatal) return;

                  console.error(
                    `Fatal hls.js error for DAM song ${popSong.songId} (${data.type}/${data.details}), retry ${hlsFatalErrorRetries}/${MAX_HLS_FATAL_ERROR_RETRIES}`,
                  );

                  if (hlsFatalErrorRetries < MAX_HLS_FATAL_ERROR_RETRIES) {
                    hlsFatalErrorRetries++;

                    switch (data.type) {
                      case Hls.ErrorTypes.NETWORK_ERROR:
                        hls?.startLoad();
                        return;
                      case Hls.ErrorTypes.MEDIA_ERROR:
                        hls?.recoverMediaError();
                        return;
                    }
                  }

                  console.error(
                    `Giving up on DAM song ${popSong.songId}, skipping`,
                  );
                  hls?.destroy();
                  M.toast({
                    html: `<span>Skipped "${popSong.name}" — playback failed</span>`,
                  });
                  pollQueue();
                });
              };

              fetch(fileUrl, { method: "HEAD" })
                .then((response) => {
                  // I can guarantee this does not happen
                  if (!videoRef.current) return;

                  if (response.ok) {
                    console.log(`Using local file for ${popSong.songId}`);
                    // This throws a random DOMException about load requests but it's probably fine
                    videoRef.current.src = fileUrl;
                  } else {
                    // Maybe it's not done downloading yet, or predownload is disabled
                    console.log(
                      `Local file for ${popSong.songId} doesn't seem available, using remote`,
                    );
                    loadRemote();
                  }
                  props.audio.gain(DAM_GAIN);

                  navigator.mediaSession.metadata = new MediaMetadata({
                    title: popSong.name,
                    artist: popSong.artistName,
                  });

                  videoRef.current.play();
                })
                .catch((error) => {
                  // This throws if the file doesn't exist (as karafriends:// is a file:// passthrough protocol)
                  console.log(
                    `Local file for ${popSong.songId} doesn't seem available, using remote`,
                  );
                  console.error(error);

                  // I can guarantee this does not happen
                  if (!videoRef.current) return;

                  // Pretend nothing happened.
                  loadRemote();

                  props.audio.gain(DAM_GAIN);

                  navigator.mediaSession.metadata = new MediaMetadata({
                    title: popSong.name,
                    artist: popSong.artistName,
                  });

                  videoRef.current.play();
                });
              break;
            case "JoysoundQueueItem":
              // Guide-melody-derived note data; absent while extraction is
              // still running or when the song has no usable melody channel.
              const hasJoysoundScoringData =
                !!popSong.scoringData && popSong.scoringData.length > 0;

              setShouldShowPianoRoll(hasJoysoundScoringData);
              setScoringData(popSong.scoringData ?? []);
              setShouldShowJoysound(true);
              setShouldShowAdhocLyrics(false);

              props.audio.gain(NON_DAM_GAIN);

              const filenameSuffix = popSong.youtubeVideoId
                ? popSong.youtubeVideoId
                : "default";

              videoRef.current.src = `karafriends://joysound-${popSong.songId}-${filenameSuffix}.mp4`;

              navigator.mediaSession.metadata = new MediaMetadata({
                title: popSong.name,
                artist: popSong.artistName,
              });

              fetch(`karafriends://joysound-${popSong.songId}.joy_02`)
                .then((resp) => resp.arrayBuffer())
                .then((data) => {
                  setJoysoundTelop(data);
                  setJoysoundIsRomaji(popSong.isRomaji);

                  invariant(videoRef.current);
                  videoRef.current.play();
                });

              break;
            case "YoutubeQueueItem":
              setShouldShowPianoRoll(false);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(popSong.hasAdhocLyrics);

              videoRef.current.src = `karafriends://yt-${popSong.songId}.mp4`;

              if (trackRef?.current && popSong?.hasCaptions) {
                trackRef.current.default = true;
                trackRef.current.src = `karafriends://yt-${popSong.songId}.vtt`;
              }

              console.log(
                `Using ${popSong.gainValue} for gain on Youtube queue item`,
              );
              props.audio.gain(popSong.gainValue);

              navigator.mediaSession.metadata = new MediaMetadata({
                title: popSong.name,
              });

              videoRef.current.play();
              break;
            case "NicoQueueItem":
              setShouldShowPianoRoll(false);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(false);

              videoRef.current.src = `karafriends://nico-${popSong.songId}.mp4`;

              props.audio.gain(NON_DAM_GAIN);

              navigator.mediaSession.metadata = new MediaMetadata({
                title: popSong.name,
              });

              videoRef.current.play();
              break;
          }
          setPlaybackState("PLAYING");
        },
        onError: (error) => {
          // Without this, any unexpected popSong failure (GraphQL error,
          // dropped connection, etc.) would kill the poll loop for good —
          // nothing else re-schedules it.
          console.error("popSong mutation failed, retrying", error);
          M.toast({
            html: "<span>⚠️ Couldn't reach the queue — retrying</span>",
          });
          pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
        },
      });

    pollQueueRef.current = pollQueue;

    videoRef.current.onended = () => {
      // With the intermission enabled, cut to the queue screen when a song
      // ends. Songs waiting: hold it for a few seconds, then pop the next
      // song. Queue empty: it doubles as the idle screen ("waiting for
      // songs" + QR code) and stays up until the next pop succeeds.
      // Playback-error skips bypass this by calling pollQueue directly.
      if (intermissionEnabledRef.current) {
        setIntermissionVisible(true);
        if (queueLengthRef.current > 0) {
          intermissionTimerRef.current = setTimeout(() => {
            intermissionTimerRef.current = null;
            pollQueue();
          }, QUEUE_INTERMISSION_MS);
        } else {
          pollQueue();
        }
        return;
      }
      pollQueue();
    };
    videoRef.current.onerror = () => {
      console.error(
        "Fatal <video> element error, skipping current song",
        videoRef.current?.error,
      );
      M.toast({ html: "<span>Skipped current song — playback failed</span>" });
      pollQueue();
    };

    if (playbackState === "WAITING" && pollTimeoutRef.current === null) {
      pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);

        pollTimeoutRef.current = null;
      }

      if (intermissionTimerRef.current) {
        clearTimeout(intermissionTimerRef.current);

        intermissionTimerRef.current = null;
      }

      if (damGuideSynthRef.current) {
        damGuideSynthRef.current.dispose();
        damGuideSynthRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;

    switch (playbackState) {
      case "PAUSED":
        videoRef.current.pause();
        break;
      case "PLAYING":
        videoRef.current.play();
        break;
      case "RESTARTING":
        // Mid-intermission restart replays the song that just ended; its
        // next natural end goes through the intermission again.
        cancelIntermission();
        videoRef.current.currentTime = 0;
        setPlaybackState("PLAYING");
        break;
      case "SKIPPING":
        if (intermissionTimerRef.current) {
          // Mid-intermission skip: start the next song right away.
          cancelIntermission();
          pollQueueRef.current?.();
          break;
        }
        if (isFinite(videoRef.current.duration))
          videoRef.current.currentTime = videoRef.current.duration;
        videoRef.current.play();
        break;
    }
  }, [playbackState]);

  useEffect(() => {
    props.audio.pitchShift(pitchShiftSemis);
  }, [props.audio, pitchShiftSemis]);

  useEffect(() => {
    if (!videoRef.current) return;

    if (audioCtx.current !== props.audio.audioContext) {
      if (videoAudioSrc.current) {
        videoAudioSrc.current.disconnect();
      }

      audioCtx.current = props.audio.audioContext;
      videoAudioSrc.current = audioCtx.current.createMediaElementSource(
        videoRef.current,
      );
      videoAudioSrc.current.connect(props.audio.videoSink());
    }
  }, [props.audio, videoRef.current]);

  return (
    <div className="karaVidContainer">
      {shouldShowJoysound && joysoundTelop !== null ? (
        <JoysoundRenderer
          telop={joysoundTelop}
          isRomaji={joysoundIsRomaji}
          kuroshiro={props.kuroshiro}
          videoRef={videoRef}
          pianoRollVisible={shouldShowPianoRoll}
        />
      ) : null}
      {shouldShowPianoRoll ? (
        <PianoRoll
          scoringData={scoringData}
          videoRef={videoRef}
          mics={props.mics}
          pitchShiftSemis={pitchShiftSemis}
        />
      ) : null}
      <video
        className="karaVid"
        ref={videoRef}
        crossOrigin="anonymous"
        controls
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
      >
        <track ref={trackRef} kind="subtitles" src="" default />
      </video>
      {shouldShowAdhocLyrics ? <AdhocLyrics /> : null}
      {intermissionVisible ? (
        <QueueIntermission queue={queue} hostname={props.hostname} />
      ) : null}
    </div>
  );
}

export default Player;
