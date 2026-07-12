import React, { useEffect, useRef, useState } from "react";

import { BGM_DIR, BGM_TRACKS, SHUFFLE_VALUE } from "../common/bgmTracks";
import usePlaybackState from "../common/hooks/usePlaybackState";

interface Props {
  trackFilename: string | null;
  volume: number;
  // Reports the canonical name of the track currently playing (null while
  // BGM is silent) so the intermission screen can show a "Now Playing" line.
  onNowPlayingChange?: (canonicalName: string | null) => void;
}

// BGM eases in from silence after a song ends instead of slamming to full
// volume, crosses track switches with a fade-out/fade-in, and ducks away
// quickly when the next song starts. Same-track looping is untouched.
// In shuffle mode, the outgoing track fades out over its final seconds
// instead of ending abruptly — except when a track shuffles into itself and
// is loopable, in which case it restarts seamlessly with no fade.
const FADE_IN_MS = 2000;
const TRACK_SWITCH_FADE_OUT_MS = 1200;
const SONG_START_FADE_OUT_MS = 400;
const SHUFFLE_END_FADE_OUT_MS = 2000;

function pickRandomTrack(): string {
  return BGM_TRACKS[Math.floor(Math.random() * BGM_TRACKS.length)].filename;
}

function isLoopable(filename: string): boolean {
  return BGM_TRACKS.some((t) => t.filename === filename && t.loopable);
}

export default function BackgroundMusic({
  trackFilename,
  volume,
  onNowPlayingChange,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { playbackState } = usePlaybackState();
  const isShuffling = trackFilename === SHUFFLE_VALUE;

  // While shuffling, this holds whichever real track is currently playing;
  // it's swapped out for another random pick each time that track ends.
  const [shuffledFilename, setShuffledFilename] = useState<string | null>(null);

  useEffect(() => {
    if (isShuffling) setShuffledFilename(pickRandomTrack());
  }, [isShuffling]);

  // Set once per shuffle playthrough when the end-of-track transition has
  // been decided (fade started or seamless loop armed), so timeupdate/ended
  // don't double-trigger it.
  const shuffleTransitionArmed = useRef(false);

  const targetFilename = isShuffling ? shuffledFilename : trackFilename;
  const shouldPlay = targetFilename !== null && playbackState === "WAITING";

  // The mounted track lags the selected one so an audible outgoing track can
  // fade out before the <audio> element is swapped (switching tracks remounts
  // the element; see the key= note below).
  const [mountedFilename, setMountedFilename] = useState<string | null>(
    targetFilename,
  );

  // Fades chase volumeRef rather than a captured value so slider drags
  // mid-fade still land on the latest volume.
  const volumeRef = useRef(volume);
  const fadeRaf = useRef<number | null>(null);

  const cancelFade = () => {
    if (fadeRaf.current !== null) {
      cancelAnimationFrame(fadeRaf.current);
      fadeRaf.current = null;
    }
  };

  const fadeTo = (
    audio: HTMLAudioElement,
    getTarget: () => number,
    durationMs: number,
    onDone?: () => void,
  ) => {
    cancelFade();
    const startVolume = audio.volume;
    const startTime = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - startTime) / durationMs, 1);
      audio.volume = startVolume + (getTarget() - startVolume) * progress;
      if (progress < 1) {
        fadeRaf.current = requestAnimationFrame(step);
      } else {
        fadeRaf.current = null;
        if (onDone) onDone();
      }
    };
    fadeRaf.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    volumeRef.current = volume;
    // Only apply directly when no fade is running; an active fade already
    // chases volumeRef.
    if (fadeRaf.current === null && audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (targetFilename === mountedFilename) return;

    const audio = audioRef.current;
    if (shouldPlay && audio && !audio.paused) {
      // A different track was selected while one is audible: fade the old
      // one out, then swap (the swap remounts the element, and the effect
      // below fades the new track in).
      fadeTo(
        audio,
        () => 0,
        TRACK_SWITCH_FADE_OUT_MS,
        () => setMountedFilename(targetFilename),
      );
    } else {
      setMountedFilename(targetFilename);
    }
  }, [targetFilename, mountedFilename, shouldPlay]);

  // The upcoming shuffle pick, chosen when the end-of-track fade is armed so
  // the ended handler lands on the same decision.
  const nextShufflePick = useRef<string | null>(null);

  // Nearing the end of a shuffle track: pick what comes next and start the
  // fade-out — unless the pick is the same track and it loops seamlessly,
  // in which case leave the volume alone and let onEnded restart it.
  const onShuffleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || !shouldPlay || shuffleTransitionArmed.current) return;
    const remainingMs = (audio.duration - audio.currentTime) * 1000;
    if (!isFinite(remainingMs) || remainingMs > SHUFFLE_END_FADE_OUT_MS) return;
    const next = pickRandomTrack();
    shuffleTransitionArmed.current = true;
    nextShufflePick.current = next;
    if (next === mountedFilename && isLoopable(next)) return;
    fadeTo(audio, () => 0, Math.max(remainingMs, 1));
  };

  const onShuffleEnded = () => {
    const audio = audioRef.current;
    const next = nextShufflePick.current ?? pickRandomTrack();
    const seamless =
      next === mountedFilename &&
      isLoopable(next) &&
      shuffleTransitionArmed.current;
    shuffleTransitionArmed.current = false;
    nextShufflePick.current = null;
    // Track ran out right as a song started (or state flapped): stay quiet
    // and let the resume effect / watchdog restart playback later.
    if (!shouldPlay) return;
    if (next !== mountedFilename) {
      // Remounts the <audio> element; the effect below fades the new track in.
      setShuffledFilename(next);
      return;
    }
    // Shuffled into itself: restart in place (setting the same filename
    // wouldn't remount or retrigger the fade-in effect).
    if (!audio) return;
    cancelFade();
    audio.currentTime = 0;
    if (seamless) {
      audio.volume = volumeRef.current;
    } else {
      audio.volume = 0;
      fadeTo(audio, () => volumeRef.current, FADE_IN_MS);
    }
    audio.play().catch((e) => console.warn("BGM replay failed", e));
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // A freshly mounted track starts a new playthrough.
    shuffleTransitionArmed.current = false;
    nextShufflePick.current = null;
    if (shouldPlay) {
      // Ease in from silence — covers both BGM resuming after a song ends
      // and a newly swapped track starting.
      if (audio.paused) {
        audio.volume = 0;
        audio.play().catch((e) => console.warn("BGM autoplay failed", e));
      }
      fadeTo(audio, () => volumeRef.current, FADE_IN_MS);
    } else if (!audio.paused) {
      fadeTo(
        audio,
        () => 0,
        SONG_START_FADE_OUT_MS,
        () => audio.pause(),
      );
    }
  }, [mountedFilename, shouldPlay]);

  // Watchdog: transitions (skips, rapid playback-state flaps, remounts,
  // rejected play() calls, an end-of-track shuffle fade that finished before
  // the swap) can strand the element paused — or playing but stuck at
  // volume 0 — while the intent says "playing". Converge on the intent
  // instead of trusting every path.
  useEffect(() => {
    if (!shouldPlay) return;
    const watchdog = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || fadeRaf.current !== null) return;
      if (audio.paused) {
        audio.volume = 0;
        audio.play().catch((e) => console.warn("BGM watchdog play failed", e));
        fadeTo(audio, () => volumeRef.current, FADE_IN_MS);
      } else if (
        volumeRef.current > 0 &&
        audio.volume < volumeRef.current - 0.01 &&
        !shuffleTransitionArmed.current
      ) {
        // Playing inaudibly with no fade in progress and not mid end-of-track
        // shuffle fade — e.g. a fade-out to 0 that never got a matching
        // fade back in. Restore the volume so BGM isn't silently "playing".
        fadeTo(audio, () => volumeRef.current, FADE_IN_MS);
      }
    }, 1000);
    return () => clearInterval(watchdog);
  }, [mountedFilename, shouldPlay]);

  // "Now Playing" is driven by the element's real play/pause events, not by
  // intent — if playback silently fails, the label must not claim otherwise.
  const [isAudible, setIsAudible] = useState(false);

  // A remounted element starts paused, but the outgoing element never fires
  // onPause when React unmounts it — reset explicitly.
  useEffect(() => {
    setIsAudible(false);
  }, [mountedFilename]);

  useEffect(() => {
    if (!onNowPlayingChange) return;
    const track = BGM_TRACKS.find((t) => t.filename === mountedFilename);
    onNowPlayingChange(isAudible && track ? track.canonicalName : null);
  }, [mountedFilename, isAudible]);

  useEffect(() => cancelFade, []);

  if (!mountedFilename) return null;
  // key={mountedFilename} forces React to fully remount the element (instead
  // of just updating its src in place) when switching tracks — Chromium
  // doesn't pick up a new src on an already-loaded <audio> element without
  // an explicit load() call, so without this, switching tracks silently
  // kept playing whatever was already loaded.
  return (
    <audio
      key={mountedFilename}
      ref={audioRef}
      src={`${BGM_DIR}${mountedFilename}`}
      loop={!isShuffling}
      onPlay={() => setIsAudible(true)}
      onPause={() => setIsAudible(false)}
      onTimeUpdate={isShuffling ? onShuffleTimeUpdate : undefined}
      onEnded={isShuffling ? onShuffleEnded : undefined}
    />
  );
}
