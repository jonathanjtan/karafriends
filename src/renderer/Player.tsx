import invariant from "ts-invariant";

import Hls from "hls.js";
import M from "materialize-css";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { commitMutation, fetchQuery, graphql } from "react-relay";
import YoutubePlayer from "youtube-player";
import { PlayerPopSongMutation } from "./__generated__/PlayerPopSongMutation.graphql";
import { PlayerRecordScoreMutation } from "./__generated__/PlayerRecordScoreMutation.graphql";
import { PlayerRecordVocalRangeMutation } from "./__generated__/PlayerRecordVocalRangeMutation.graphql";
import { PlayerScoreHistoryQuery } from "./__generated__/PlayerScoreHistoryQuery.graphql";
import { PlayerSongPlayCountQuery } from "./__generated__/PlayerSongPlayCountQuery.graphql";

import environment from "../common/graphqlEnvironment";
import useBreakEndsAt from "../common/hooks/useBreakEndsAt";
import useBreakMessage from "../common/hooks/useBreakMessage";
import useExperimentalScoringEnabled from "../common/hooks/useExperimentalScoringEnabled";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import useQueue from "../common/hooks/useQueue";
import useQueueIntermissionEnabled from "../common/hooks/useQueueIntermissionEnabled";
import { KuroshiroSingleton } from "../common/joysoundParser";
import { isScoreable, ScoreAccumulator } from "../common/scoring";
import {
  findInstrumentalBreaks,
  parseScoringData,
} from "../common/scoringData";
import { buildTuningExercise } from "../common/tuningExercise";
import { RangeAccumulator } from "../common/vocalRange";
import AdhocLyrics from "./AdhocLyrics";
import DamGuideMelodySynth from "./damGuideMelody";
import JoysoundRenderer from "./JoysoundRenderer";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import QueueIntermission from "./QueueIntermission";
import RangeCard, { MeasuredRange } from "./RangeCard";
import ScoreCard, { ScoredPerformance } from "./ScoreCard";
import KarafriendsAudio from "./webAudio";

const songPlayCountQuery = graphql`
  query PlayerSongPlayCountQuery(
    $songType: String!
    $songId: String!
    $nickname: String!
    $personId: String
  ) {
    songPlayCount(
      songType: $songType
      songId: $songId
      nickname: $nickname
      personId: $personId
    )
  }
`;

const scoreHistoryQuery = graphql`
  query PlayerScoreHistoryQuery(
    $songType: String!
    $songId: String!
    $nickname: String!
    $personId: String
  ) {
    scoreHistory(
      songType: $songType
      songId: $songId
      nickname: $nickname
      personId: $personId
    ) {
      count
      best {
        display
        band
      }
    }
  }
`;

const recordScoreMutation = graphql`
  mutation PlayerRecordScoreMutation($input: ScoreRecordInput!) {
    recordScore(input: $input)
  }
`;

const popSongMutation = graphql`
  mutation PlayerPopSongMutation {
    popSong {
      ... on DamQueueItem {
        __typename
        pitchShiftSemis
        songId
        streamingUrls {
          url
        }
        scoringData
        timestamp
        streamingUrlIdx
        name
        artistName
        userIdentity {
          nickname
          profilePictureUrl
          personId
        }
      }
      ... on JoysoundQueueItem {
        __typename
        pitchShiftSemis
        songId
        timestamp
        name
        artistName
        isRomaji
        youtubeVideoId
        scoringData
        userIdentity {
          nickname
          profilePictureUrl
          personId
        }
      }
      ... on YoutubeQueueItem {
        __typename
        pitchShiftSemis
        songId
        timestamp
        hasAdhocLyrics
        hasCaptions
        gainValue
        name
      }
      ... on NicoQueueItem {
        __typename
        pitchShiftSemis
        songId
        timestamp
        name
      }
      ... on TuningQueueItem {
        __typename
        pitchShiftSemis
        songId
        timestamp
        name
        artistName
        scoringData
        centreMidi
        stepSemis
        floorMidi
        ceilingMidi
        durationSecs
        userIdentity {
          nickname
          profilePictureUrl
          personId
        }
      }
    }
  }
`;

const recordVocalRangeMutation = graphql`
  mutation PlayerRecordVocalRangeMutation($input: VocalRangeInput!) {
    recordVocalRange(input: $input)
  }
`;

const POLL_INTERVAL_MS = 5 * 1000;
// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const NON_DAM_GAIN = 0.8;
const MAX_HLS_FATAL_ERROR_RETRIES = 2;
// HTMLMediaElement.readyState: below this the element has no frame at all, so
// it isn't playing and can't be seeked or ended — the signature of a song that
// never loaded, as opposed to one someone paused with the on-screen controls.
const HAVE_CURRENT_DATA = 2;
// Consecutive watchdog ticks (POLL_INTERVAL_MS apart) before it resumes the
// queue. A stalled-and-paused player is unambiguous; a source that simply
// hasn't produced a frame yet might still be loading, so it gets longer.
const WEDGE_TICKS_PAUSED = 2;
const WEDGE_TICKS_NO_DATA = 5;
// How long the between-songs queue screen stays up before the next song
// starts (when queueIntermissionEnabled is on).
const QUEUE_INTERMISSION_MS = 12 * 1000;
// Fade duration for the intermission screen; keep in sync with the
// animation durations in QueueIntermission.css.
const QUEUE_INTERMISSION_FADE_MS = 4500;

// EXPERIMENTAL scoring. Keep in sync with the animation durations in
// ScoreCard.css.
const SCORE_CARD_FADE_MS = 1400;
// How long the score card holds before dissolving into the queue screen.
// Must stay comfortably inside QUEUE_INTERMISSION_MS so it is gone before the
// next song pops; a pop also force-clears it as a hard guarantee.
const SCORE_CARD_HOLD_MS = 9000;
// The card's whole life, hold plus fade. When a song ends with nothing queued
// behind it there is no intermission hold to sit inside, so the queue is held
// off by exactly this long instead — otherwise pollQueue's clearScoreCard
// wipes the card in the same tick it was revealed and it never paints.
const SCORE_CARD_TOTAL_MS = SCORE_CARD_HOLD_MS + SCORE_CARD_FADE_MS;

function Player(props: {
  mics: InputDevice[];
  // Passed straight through to PianoRoll, which is the only thing that may
  // poll the mics (getPitch pops the native ring buffer).
  micLevelsRef?: React.MutableRefObject<number[]>;
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
  hostname: string;
  bgmNowPlaying: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const [scoringData, setScoringData] = useState<readonly number[]>([]);
  // The current song's id, passed to PianoRoll only so the latency-probe
  // capture can tag each sample -- lets a multi-song probe log be split by
  // song later. Not used for scoring itself.
  const [scoringSongId, setScoringSongId] = useState<string>("");

  const [joysoundTelop, setJoysoundTelop] = useState<ArrayBuffer | null>(null);
  const [shouldShowJoysound, setShouldShowJoysound] = useState<boolean>(false);
  const [joysoundIsRomaji, setJoysoundIsRomaji] = useState<boolean>(false);

  const [shouldShowPianoRoll, setShouldShowPianoRoll] = useState<boolean>(true);
  // Gates the piano roll's fade-in so it doesn't cover the JOYSOUND title
  // card; DAM/Youtube/Nico have no title card so they clear it immediately.
  const [pianoRollTitleCleared, setPianoRollTitleCleared] =
    useState<boolean>(true);
  // Dims the piano roll while a JOYSOUND instrumental break is announced.
  const [pianoRollDucked, setPianoRollDucked] = useState<boolean>(false);
  const instrumentalBreaks = useMemo(
    () =>
      findInstrumentalBreaks(parseScoringData(scoringData).freeTimeIntervals),
    [scoringData],
  );
  const [shouldShowAdhocLyrics, setShouldShowAdhocLyrics] =
    useState<boolean>(false);

  // EXPERIMENTAL scoring. The accumulator lives here rather than in PianoRoll
  // because "ended" is handled here and PianoRoll's GL effect still rebuilds
  // whenever the song (or mic list, or pitch shift) changes, which would
  // discard the performance. It used to rebuild on every render of this
  // component too -- that was a bug in PianoRoll's effect deps, since fixed;
  // it was silently erasing the sung-pitch trail mid-song. It is fed from
  // PianoRoll's poll loop and read once, on "ended".
  const scoreAccumulatorRef = useRef<ScoreAccumulator | null>(null);
  // Who sang what, captured at pop time: the "ended" handler is wired up once
  // on mount and can't close over per-song state.
  const scoredSongMetaRef = useRef<Omit<ScoredPerformance, "result"> | null>(
    null,
  );
  // Which song and singer the armed take belongs to. Kept apart from the card's
  // meta because the card has no use for it -- it is what the score record is
  // keyed on when the take is persisted.
  const scoredSongIdentityRef = useRef<{
    songType: string;
    songId: string;
    songName: string;
    artistName: string | null;
    nickname: string;
    personId: string | null;
  } | null>(null);
  const [scoredPerformance, setScoredPerformance] =
    useState<ScoredPerformance | null>(null);
  const [scoreCardVisible, setScoreCardVisible] = useState(false);
  const scoreCardTimersRef = useRef<NodeJS.Timeout[]>([]);

  // The warm-up's counterparts. Kept beside the scoring ones rather than folded
  // into them because the two are mutually exclusive and merging them would
  // mean a card component that has to ask which kind it is.
  const rangeAccumulatorRef = useRef<RangeAccumulator | null>(null);
  const measuredRangeMetaRef = useRef<{
    nickname: string;
    profilePictureUrl: string | null;
    personId: string | null;
  } | null>(null);
  const [measuredRange, setMeasuredRange] = useState<MeasuredRange | null>(
    null,
  );
  const [rangeCardVisible, setRangeCardVisible] = useState(false);

  // Read through a ref by the once-on-mount "ended" handler. Songs always
  // accumulate (the cost is a map insert per poll), and only the reveal
  // consults the toggle -- so switching scoring on part-way through a song
  // still produces a card for the whole performance, and switching it off
  // suppresses one immediately.
  const { experimentalScoringEnabled } = useExperimentalScoringEnabled();
  const experimentalScoringEnabledRef = useRef(false);
  experimentalScoringEnabledRef.current = experimentalScoringEnabled;
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Between-songs queue screen. The onended/pollQueue closures are wired up
  // once on mount, so they read the live setting and queue length through
  // refs rather than captured state.
  const queue = useQueue();
  const { queueIntermissionEnabled } = useQueueIntermissionEnabled();
  const [intermissionVisible, setIntermissionVisible] = useState(false);
  // Stays true through the fade-out so the screen can animate away instead
  // of unmounting instantly.
  const [intermissionMounted, setIntermissionMounted] = useState(false);
  const intermissionEnabledRef = useRef(queueIntermissionEnabled);
  const queueLengthRef = useRef(queue.length);
  const queueRef = useRef(queue);
  // Snapshot of the queue taken just before a pop, rendered from that moment
  // through the intermission's fade-out so the popped song doesn't visibly
  // vanish from "Up Next" (e.g. flashing "Nothing..." on the last song)
  // mid-dissolve. popPending covers the window where the queue subscription
  // update outraces the pop mutation's response.
  const frozenQueueRef = useRef(queue);
  const [popPending, setPopPending] = useState(false);
  const popPendingRef = useRef(false);
  const intermissionTimerRef = useRef<NodeJS.Timeout | null>(null);
  // The intermission's own minimum hold deadline (epoch ms); the effective
  // hold is the max of this and any active break.
  const intermissionDeadlineRef = useRef<number | null>(null);
  const pollQueueRef = useRef<((force?: boolean) => void) | null>(null);

  // Break: while breakEndsAt is in the future, hold on the intermission
  // screen (and don't pop queued songs) until it passes or is cleared.
  const { breakEndsAt, setBreakEndsAt } = useBreakEndsAt();
  const { breakMessage } = useBreakMessage();
  const breakEndsAtRef = useRef<number | null>(breakEndsAt);
  const playbackStateRef = useRef(playbackState);

  useEffect(() => {
    breakEndsAtRef.current = breakEndsAt;
  }, [breakEndsAt]);

  useEffect(() => {
    playbackStateRef.current = playbackState;
  }, [playbackState]);

  useEffect(() => {
    popPendingRef.current = popPending;
  }, [popPending]);

  // The renderer is the single authority for expiring a break: clear it
  // server-side the moment it runs out, so every remocon's button flips back
  // without each client having to tick its own clock.
  useEffect(() => {
    if (breakEndsAt === null) return;
    const remainingMs = breakEndsAt - Date.now();
    if (remainingMs <= 0) {
      setBreakEndsAt(null);
      return;
    }
    const expireTimer = setTimeout(() => setBreakEndsAt(null), remainingMs);
    return () => clearTimeout(expireTimer);
  }, [breakEndsAt]);

  useEffect(() => {
    intermissionEnabledRef.current = queueIntermissionEnabled;
  }, [queueIntermissionEnabled]);

  useEffect(() => {
    queueLengthRef.current = queue.length;
    queueRef.current = queue;
  }, [queue]);

  // Fade in/out: mount immediately when shown; on hide, keep the component
  // mounted for the fade-out animation, then unmount.
  useEffect(() => {
    if (intermissionVisible) {
      setIntermissionMounted(true);
      return;
    }
    if (!intermissionMounted) return;
    const fadeTimer = setTimeout(
      () => setIntermissionMounted(false),
      QUEUE_INTERMISSION_FADE_MS,
    );
    return () => clearTimeout(fadeTimer);
  }, [intermissionVisible]);

  const cancelIntermission = () => {
    if (intermissionTimerRef.current) {
      clearTimeout(intermissionTimerRef.current);
      intermissionTimerRef.current = null;
    }
    intermissionDeadlineRef.current = null;
    setIntermissionVisible(false);
  };

  // The onended path only covers songs that finish while the app is up; show
  // the idle screen any time we're WAITING with nothing playing too (fresh
  // launch, or the setting flipped on while idle). It comes down via the
  // pop-success handler when a song actually starts. A break forces it up
  // even with the intermission setting off — it doubles as the break screen.
  useEffect(() => {
    if (
      playbackState === "WAITING" &&
      (queueIntermissionEnabled || breakEndsAt !== null)
    ) {
      setIntermissionVisible(true);
    }
  }, [playbackState, queueIntermissionEnabled, breakEndsAt]);

  useEffect(() => {
    if (queueIntermissionEnabled) return;
    if (breakEndsAt !== null) return; // break keeps the screen up regardless
    // Setting turned off mid-intermission: if the next song was pending on
    // the timer, start it now; if the idle screen was up, just hide it.
    const timerWasPending = intermissionTimerRef.current !== null;
    cancelIntermission();
    if (timerWasPending) pollQueueRef.current?.();
  }, [queueIntermissionEnabled, breakEndsAt]);

  const audioCtx = useRef<AudioContext | null>(null);
  const videoAudioSrc = useRef<MediaElementAudioSourceNode | null>(null);
  const damGuideSynthRef = useRef<DamGuideMelodySynth | null>(null);

  let hls: Hls | null = null;

  useEffect(() => {
    if (!videoRef.current) return;

    const clearScoreCard = () => {
      scoreCardTimersRef.current.forEach(clearTimeout);
      scoreCardTimersRef.current = [];
      setScoreCardVisible(false);
      setScoredPerformance(null);
      scoreAccumulatorRef.current = null;
      scoredSongMetaRef.current = null;
      scoredSongIdentityRef.current = null;
      // The range card shares the same timer list and the same "a new song must
      // never come up underneath a lingering card" guarantee.
      setRangeCardVisible(false);
      setMeasuredRange(null);
      rangeAccumulatorRef.current = null;
      measuredRangeMetaRef.current = null;
    };

    // Total mic-to-score latency compensation, read fresh per song. The
    // config value covers the input/ADC/USB path (measured with the sweep;
    // macOS/cpal cannot report it truthfully), and live outputLatency covers
    // the playback path the singer is reacting to -- that one genuinely
    // changes at runtime (wired speakers vs Bluetooth swing it by tens of ms),
    // so it is read here rather than folded into the constant. outputLatency
    // is unset on some backends; treat a missing value as 0.
    const micLatencyCompensationMs = (): number => {
      const calibrationMs =
        window.karafriends.karafriendsConfig().micLatencyCalibrationMs;
      const outputLatencyMs =
        (props.audio.audioContext.outputLatency || 0) * 1000;
      return calibrationMs + outputLatencyMs;
    };

    // Arm scoring for a song that carries usable reference notes. DAM's blob
    // and Joysound's extracted melody share a layout, so both arrive here.
    // Deliberately not gated on the toggle -- see the ref above. A melody too
    // thin to judge leaves scoring disarmed, which is also what keeps
    // Youtube/Nico (no reference data at all) from ever showing a card.
    const armScoring = (
      songScoringData: readonly number[],
      meta: Omit<
        ScoredPerformance,
        "result" | "instrumentalBreaks" | "timesSung" | "personalBest"
      >,
      song: { songType: string; songId: string; personId: string | null },
    ) => {
      const { notes, lyricsIntervals, freeTimeIntervals } =
        parseScoringData(songScoringData);
      if (!isScoreable(notes)) return;

      scoreAccumulatorRef.current = new ScoreAccumulator(
        notes,
        lyricsIntervals,
        micLatencyCompensationMs(),
      );
      // Shaded on the card's note ribbon. Derived here rather than passed in by
      // each call site: this function already has the parsed data, and the
      // component-level `instrumentalBreaks` memo tracks the *current* song,
      // which by reveal time is the next one.
      const armed: Omit<ScoredPerformance, "result"> = {
        ...meta,
        instrumentalBreaks: findInstrumentalBreaks(freeTimeIntervals),
        timesSung: 0,
        personalBest: null,
      };
      scoredSongMetaRef.current = armed;
      scoredSongIdentityRef.current = {
        songType: song.songType,
        songId: song.songId,
        songName: meta.songName,
        artistName: meta.artistName,
        nickname: meta.nickname,
        personId: song.personId,
      };

      // Fetched now, before this take is recorded, so "your best" is the score
      // to beat rather than the one just set.
      fetchQuery<PlayerScoreHistoryQuery>(environment, scoreHistoryQuery, {
        songType: song.songType,
        songId: song.songId,
        nickname: meta.nickname,
        personId: song.personId,
      }).subscribe({
        next: (response) => {
          const best = response.scoreHistory.best;
          if (scoredSongMetaRef.current === armed && best) {
            armed.personalBest = { display: best.display, band: best.band };
          }
        },
        error: (err: Error) =>
          console.error("Score history query failed:", err),
      });

      // Fetched now rather than at reveal: the pop that started this song has
      // already written it to the history, so the count is settled and
      // includes this play. It also means a slow query can't delay the card.
      //
      // Zero when history recording is off (the dev default), which the card
      // reads the same as one -- see the copy in ScoreCard.
      fetchQuery<PlayerSongPlayCountQuery>(environment, songPlayCountQuery, {
        songType: song.songType,
        songId: song.songId,
        nickname: meta.nickname,
        personId: song.personId,
      }).subscribe({
        next: (response) => {
          // Only if this is still the armed song: the fetch outlives a skip,
          // and writing into the ref blindly would label the next singer's
          // card with this one's count.
          if (scoredSongMetaRef.current === armed) {
            armed.timesSung = response.songPlayCount;
          }
        },
        // A missing count is a missing line on the card, not a broken song.
        error: (err: Error) =>
          console.error("Song play count query failed:", err),
      });
    };

    // Finalize whatever the accumulator collected and put the card up. Always
    // consumes the accumulator, so a song that ends without a scoreable
    // result can't leak into the next one. Returns whether a card actually
    // went up, so the caller knows to hold the queue off while it plays.
    const revealScoreCard = (): boolean => {
      const accumulator = scoreAccumulatorRef.current;
      const meta = scoredSongMetaRef.current;
      const identity = scoredSongIdentityRef.current;
      scoreAccumulatorRef.current = null;
      scoredSongMetaRef.current = null;
      scoredSongIdentityRef.current = null;
      if (accumulator === null || meta === null) return false;
      if (!experimentalScoringEnabledRef.current) return false;

      const result = accumulator.finalize();
      if (result === null) return false;
      // Nobody sang against a single note — a skipped song (the skip seeks to
      // the end, and a seek resets the tally) or an empty room. Scoring that
      // as a D is worse than staying quiet.
      if (result.notesAttempted === 0) return false;

      // Persisted before the card is even drawn: this is the durable record a
      // later personal best reads, and it must not depend on the card
      // surviving its nine seconds. Main ignores it while history recording is
      // off, so test queueing leaves no scores behind.
      if (identity !== null) {
        commitMutation<PlayerRecordScoreMutation>(environment, {
          mutation: recordScoreMutation,
          variables: {
            input: {
              ...identity,
              display: result.display,
              band: result.band,
              overall: result.overall,
              pitch: result.pitch,
              longTone: result.longTone,
              timing: result.timing,
              compensationMs: result.compensationMs,
            },
          },
          onError: (err) => console.error("Recording the score failed:", err),
        });
      }

      scoreCardTimersRef.current.forEach(clearTimeout);
      scoreCardTimersRef.current = [];
      setScoredPerformance({ ...meta, result });
      setScoreCardVisible(true);
      scoreCardTimersRef.current.push(
        // Screenshot once the fade-in has finished, so the saved PNG catches
        // the card crisp rather than mid-dissolve. Fire-and-forget: the main
        // handler never rejects, and a failed grab must not disturb playback.
        setTimeout(() => {
          window.karafriends
            .saveScoreCard({
              songName: meta.songName,
              band: result.band,
              overall: Math.round(result.display),
            })
            .catch((err) =>
              console.error("Score card screenshot request failed:", err),
            );
        }, SCORE_CARD_FADE_MS + 200),
        setTimeout(() => setScoreCardVisible(false), SCORE_CARD_HOLD_MS),
        setTimeout(() => setScoredPerformance(null), SCORE_CARD_TOTAL_MS),
      );

      return true;
    };

    // Measure whatever the warm-up collected and put the range card up. Mirrors
    // revealScoreCard: always consumes the accumulator so a warm-up can't leak
    // into the next item, and returns whether a card went up so the caller
    // knows to hold the queue off while it plays.
    const revealRangeCard = (): boolean => {
      const accumulator = rangeAccumulatorRef.current;
      const meta = measuredRangeMetaRef.current;
      rangeAccumulatorRef.current = null;
      measuredRangeMetaRef.current = null;
      if (accumulator === null || meta === null) return false;

      const result = accumulator.finalize();
      if (result === null) return false;

      // Persisted before the card is drawn, exactly like a score: this is the
      // durable record the remocon's song suggestions read, and it must not
      // depend on the card surviving its nine seconds. Main ignores it while
      // history recording is off, so a warm-up sung to test the app leaves no
      // range attached to anybody.
      //
      // A null range is still recorded: "we measured you and heard nothing" is
      // a real outcome, and storing it stops the profile page claiming a stale
      // range from last week is current.
      commitMutation<PlayerRecordVocalRangeMutation>(environment, {
        mutation: recordVocalRangeMutation,
        variables: {
          input: {
            personId: meta.personId,
            nickname: meta.nickname,
            lowMidi: result.lowMidi,
            highMidi: result.highMidi,
            comfortableLowMidi: result.comfortableLowMidi,
            comfortableHighMidi: result.comfortableHighMidi,
            hitFloor: result.hitFloor,
            hitCeiling: result.hitCeiling,
            version: result.version,
          },
        },
        onError: (err) => console.error("Recording the range failed:", err),
      });

      scoreCardTimersRef.current.forEach(clearTimeout);
      scoreCardTimersRef.current = [];
      setMeasuredRange({
        result,
        nickname: meta.nickname,
        profilePictureUrl: meta.profilePictureUrl,
      });
      setRangeCardVisible(true);
      scoreCardTimersRef.current.push(
        setTimeout(() => setRangeCardVisible(false), SCORE_CARD_HOLD_MS),
        setTimeout(() => setMeasuredRange(null), SCORE_CARD_TOTAL_MS),
      );

      return true;
    };

    const pollQueue = (force: boolean = false) => {
      // No poll is in flight once we're inside one, whether this call came
      // from the timer (whose handle is already spent) or straight from a
      // media event. Leaving a stale handle parked here silently disabled the
      // wedge watchdog below for the rest of the session — it requires "no
      // poll in flight", and nothing on the success path ever nulled this —
      // and let a pending timer double-pop behind a direct call.
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      // On break: don't start anything. Keep checking so playback resumes
      // shortly after the break ends or is cancelled. An explicit skip
      // (force) overrides the break.
      if (
        !force &&
        breakEndsAtRef.current !== null &&
        breakEndsAtRef.current > Date.now()
      ) {
        if (playbackStateRef.current !== "WAITING") {
          setPlaybackState("WAITING");
        }
        pollTimeoutRef.current = setTimeout(pollQueue, 1000);
        return;
      }
      // Snapshot before the pop mutates the server-side queue, so the
      // fade-out renders the pre-pop state no matter when the queue
      // subscription update lands.
      frozenQueueRef.current = queueRef.current;
      // A new song must never come up underneath a lingering score card.
      clearScoreCard();
      setPopPending(true);
      commitMutation<PlayerPopSongMutation>(environment, {
        mutation: popSongMutation,
        variables: {},
        onCompleted: ({ popSong }) => {
          setPopPending(false);
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

          // Start each item in the key it was queued for. This used to be an
          // unconditional reset to 0, which is exactly what a null/absent value
          // still means -- older clients and everything already in queue.json
          // behave as they always did.
          //
          // The `in` guard is for Relay's "%other" branch, which stands for a
          // queue item type this build doesn't know about; it carries no fields
          // at all, and 0 is the right reading for it anyway.
          setPitchShiftSemis(
            "pitchShiftSemis" in popSong ? (popSong.pitchShiftSemis ?? 0) : 0,
          );

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
              setPianoRollTitleCleared(true);
              setPianoRollDucked(false);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(false);
              setScoringData(popSong.scoringData);
              setScoringSongId(popSong.songId);

              armScoring(
                popSong.scoringData,
                {
                  songName: popSong.name,
                  artistName: popSong.artistName,
                  nickname: popSong.userIdentity.nickname,
                  profilePictureUrl:
                    popSong.userIdentity.profilePictureUrl ?? null,
                },
                {
                  songType: popSong.__typename,
                  songId: popSong.songId,
                  personId: popSong.userIdentity.personId ?? null,
                },
              );

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

                  // A manifest that never loaded at all is not a retryable
                  // blip: hls.js has no level parsed to resume, so startLoad()
                  // is a no-op that emits no further events, and the give-up
                  // path below never runs. DAM's CDN 403s from some exit IPs
                  // (see CLAUDE.md), which is exactly this case — the song sat
                  // there with the room staring at a stalled player.
                  const manifestUnrecoverable =
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                    data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
                    data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;

                  if (
                    !manifestUnrecoverable &&
                    hlsFatalErrorRetries < MAX_HLS_FATAL_ERROR_RETRIES
                  ) {
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
              // Wait for JoysoundRenderer's title card to fade out before
              // fading the piano roll in over it.
              setPianoRollTitleCleared(false);
              setPianoRollDucked(false);
              setScoringData(popSong.scoringData ?? []);
              setScoringSongId(popSong.songId);
              setShouldShowJoysound(true);
              setShouldShowAdhocLyrics(false);

              armScoring(
                popSong.scoringData ?? [],
                {
                  songName: popSong.name,
                  artistName: popSong.artistName,
                  nickname: popSong.userIdentity.nickname,
                  profilePictureUrl:
                    popSong.userIdentity.profilePictureUrl ?? null,
                },
                {
                  songType: popSong.__typename,
                  songId: popSong.songId,
                  personId: popSong.userIdentity.personId ?? null,
                },
              );

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
                })
                .catch((error) => {
                  // Without this, a missing/corrupt telop file means play()
                  // is never called and no media event ever fires — the poll
                  // loop dies with playbackState stuck on PLAYING (silent
                  // room, stale "Now Playing", no BGM) until relaunch.
                  console.error(
                    `Failed to load telop for joysound song ${popSong.songId}, skipping`,
                    error,
                  );
                  M.toast({
                    html: `<span>Skipped "${popSong.name}" — lyrics data unavailable</span>`,
                  });
                  pollQueue();
                });

              break;
            case "YoutubeQueueItem":
              setShouldShowPianoRoll(false);
              setPianoRollTitleCleared(true);
              setPianoRollDucked(false);
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
              setPianoRollTitleCleared(true);
              setPianoRollDucked(false);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(false);

              videoRef.current.src = `karafriends://nico-${popSong.songId}.mp4`;

              props.audio.gain(NON_DAM_GAIN);

              navigator.mediaSession.metadata = new MediaMetadata({
                title: popSong.name,
              });

              videoRef.current.play();
              break;
            case "TuningQueueItem":
              setShouldShowPianoRoll(true);
              setPianoRollTitleCleared(true);
              setPianoRollDucked(false);
              setShouldShowJoysound(false);
              setShouldShowAdhocLyrics(false);
              // Never null in practice -- the exercise is generated at queue
              // time. The field is nullable only to satisfy Relay's union
              // typing (see the schema comment).
              setScoringData(popSong.scoringData ?? []);
              setScoringSongId(popSong.songId);

              // Deliberately NOT armScoring. The exercise carries ~19 notes
              // and would clear isScoreable's floor of 24 on a longer preset,
              // which would put a score card on a warm-up and write a bogus
              // personal best for a song that isn't one.
              rangeAccumulatorRef.current = new RangeAccumulator(
                buildTuningExercise({
                  centreMidi: popSong.centreMidi,
                  stepSemis: popSong.stepSemis,
                  floorMidi: popSong.floorMidi,
                  ceilingMidi: popSong.ceilingMidi,
                }).targets,
                micLatencyCompensationMs(),
              );
              measuredRangeMetaRef.current = {
                nickname: popSong.userIdentity.nickname,
                profilePictureUrl:
                  popSong.userIdentity.profilePictureUrl ?? null,
                personId: popSong.userIdentity.personId ?? null,
              };

              // The exercise's tones. Same synth DAM uses, for the same reason:
              // there is no recorded guide to play, so one is generated against
              // the video clock and routed through the guide-melody volume.
              damGuideSynthRef.current = new DamGuideMelodySynth(
                props.audio.audioContext,
                props.audio.guideMelodySynthSink(),
                videoRef.current,
                popSong.scoringData ?? [],
              );

              // Silent black video generated at queue time; it exists only to
              // give this component a clock and an "ended".
              videoRef.current.src = `karafriends://tuning-${Math.round(popSong.durationSecs * 10) / 10}.mp4`;

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
          setPopPending(false);
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
    };

    pollQueueRef.current = pollQueue;

    // Hold the intermission screen until both its own minimum duration and
    // any active break have passed, then start the next song. Checked on a
    // short tick so a break started, extended, or ended mid-hold is honored
    // without rearming anything.
    const holdIntermission = (deadline: number) => {
      intermissionDeadlineRef.current = deadline;
      const tick = () => {
        const breakUntil = breakEndsAtRef.current ?? 0;
        const effective = Math.max(
          intermissionDeadlineRef.current ?? 0,
          breakUntil,
        );
        const remaining = effective - Date.now();
        if (remaining <= 0) {
          intermissionTimerRef.current = null;
          intermissionDeadlineRef.current = null;
          pollQueue();
          return;
        }
        // While the intermission screen is held (a plain between-songs hold
        // or an active break) the room is idle — flip to WAITING so BGM
        // plays. pollQueue flips it back to PLAYING when the next song pops.
        if (playbackStateRef.current !== "WAITING") {
          setPlaybackState("WAITING");
        }
        intermissionTimerRef.current = setTimeout(
          tick,
          Math.min(remaining, 500),
        );
      };
      tick();
    };

    videoRef.current.onended = () => {
      // EXPERIMENTAL scoring: read the performance before anything else
      // touches the queue. No-op when the flag is off, when the song had no
      // reference melody, or when a seek reset the tally below scoreable.
      //
      // Whether a card went up decides how long the queue waits: every path
      // out of here ends in pollQueue, whose first act is clearScoreCard, so
      // a synchronous call would blow the card away in the tick it appeared.
      // holdIntermission is the delay mechanism rather than a bare setTimeout
      // because it parks the handle the skip path cancels and the poll
      // watchdog checks — a raw timer would let a skip mid-card double-pop.
      // Only one of the two can be armed, so at most one card goes up; the
      // queue-hold logic below treats them identically.
      const scoreCardShown = revealScoreCard() || revealRangeCard();

      // With the intermission enabled, cut to the queue screen when a song
      // ends. Songs waiting: hold it for a few seconds, then pop the next
      // song. Queue empty: it doubles as the idle screen ("waiting for
      // songs" + QR code) and stays up until the next pop succeeds.
      // Playback-error skips bypass this by calling pollQueue directly.
      if (intermissionEnabledRef.current) {
        setIntermissionVisible(true);
        if (queueLengthRef.current > 0) {
          holdIntermission(Date.now() + QUEUE_INTERMISSION_MS);
        } else if (scoreCardShown) {
          holdIntermission(Date.now() + SCORE_CARD_TOTAL_MS);
        } else {
          pollQueue();
        }
        return;
      }
      if (scoreCardShown) {
        holdIntermission(Date.now() + SCORE_CARD_TOTAL_MS);
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

    // Watchdog: the queue only advances through this chain of callbacks
    // (media events -> pollQueue -> commitMutation callbacks), and nothing
    // re-arms it if a link dies — the bootstrap above runs once at mount. A
    // song that never reaches play() (and so never fires ended/error) leaves
    // playbackState wedged on PLAYING with a silent room, a stale
    // "Now Playing", and no BGM until relaunch. Detect that state — PLAYING
    // but the <video> never started (or already ended) with no pop, poll, or
    // intermission hold in flight — and restart the loop.
    //
    // currentTime === 0 / ended distinguishes a wedge from someone pausing
    // mid-song with the on-screen video controls (which doesn't go through
    // playbackState and must not trigger a skip).
    //
    // "Nothing is playing" is not just video.paused: play() flips paused to
    // false optimistically, before any data arrives, so a source that never
    // loads (hls.js on a 403 manifest) leaves paused === false forever and the
    // watchdog looking the other way. readyState covers that — no frame at all
    // is never a healthy song, and a hand-paused one has data and a nonzero
    // currentTime, so the clause below still can't fire on it. SKIPPING counts
    // as wedgeable for the same reason: it's a transient state, and a skip that
    // couldn't take effect leaves it stuck there.
    let wedgedTicks = 0;
    const pollWatchdog = setInterval(() => {
      const video = videoRef.current;
      if (video === null) {
        wedgedTicks = 0;
        return;
      }
      const maybeWedged =
        (playbackStateRef.current === "PLAYING" ||
          playbackStateRef.current === "SKIPPING") &&
        !popPendingRef.current &&
        pollTimeoutRef.current === null &&
        intermissionTimerRef.current === null &&
        (video.paused || video.readyState < HAVE_CURRENT_DATA) &&
        !video.seeking &&
        (video.currentTime === 0 || video.ended);
      if (!maybeWedged) {
        wedgedTicks = 0;
        return;
      }
      wedgedTicks += 1;
      // A song still loading looks exactly like one that never will, just
      // earlier — time is the only thing that tells them apart, so a source
      // that hasn't produced a frame yet gets a longer leash than a player
      // that's outright paused and stalled.
      if (
        wedgedTicks < (video.paused ? WEDGE_TICKS_PAUSED : WEDGE_TICKS_NO_DATA)
      ) {
        return;
      }
      wedgedTicks = 0;
      console.error(
        `Player watchdog: playbackState is ${playbackStateRef.current} but nothing is playing and no pop is in flight; resuming the queue`,
      );
      pollQueue();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(pollWatchdog);

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

      scoreCardTimersRef.current.forEach(clearTimeout);
      scoreCardTimersRef.current = [];
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
          // Mid-intermission (or mid-break) skip: start the next song right
          // away; an explicit skip overrides an active break.
          cancelIntermission();
          pollQueueRef.current?.(true);
          break;
        }
        // A song that never actually loaded (DAM CDN 403, missing local file)
        // has no duration and no data, so seeking to the end can't fire
        // "ended" and the skip did nothing at all — the queue stayed wedged and
        // playbackState stuck on SKIPPING, with the remocon's skip button doing
        // visibly nothing however many times it was pressed. Pop the next song
        // directly instead; the watchdog above only backstops this.
        if (
          !isFinite(videoRef.current.duration) ||
          videoRef.current.readyState < HAVE_CURRENT_DATA
        ) {
          pollQueueRef.current?.(true);
          break;
        }
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
          onTitleFadeout={() => setPianoRollTitleCleared(true)}
          breaks={instrumentalBreaks}
          onBreakActiveChange={setPianoRollDucked}
        />
      ) : null}
      {shouldShowPianoRoll ? (
        <PianoRoll
          scoringData={scoringData}
          songId={scoringSongId}
          videoRef={videoRef}
          mics={props.mics}
          pitchShiftSemis={pitchShiftSemis}
          visible={pianoRollTitleCleared}
          ducked={pianoRollDucked}
          scoreAccumulatorRef={scoreAccumulatorRef}
          rangeAccumulatorRef={rangeAccumulatorRef}
          micLevelsRef={props.micLevelsRef}
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
      {scoredPerformance !== null ? (
        <ScoreCard performance={scoredPerformance} hiding={!scoreCardVisible} />
      ) : null}
      {measuredRange !== null ? (
        <RangeCard performance={measuredRange} hiding={!rangeCardVisible} />
      ) : null}
      {intermissionMounted ? (
        <QueueIntermission
          queue={
            intermissionVisible && !popPending ? queue : frozenQueueRef.current
          }
          hostname={props.hostname}
          hiding={!intermissionVisible}
          breakEndsAt={breakEndsAt}
          breakMessage={breakMessage}
          bgmNowPlaying={props.bgmNowPlaying}
        />
      ) : null}
    </div>
  );
}

export default Player;
