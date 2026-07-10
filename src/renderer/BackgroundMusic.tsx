import React, { useEffect, useRef, useState } from "react";

import { BGM_DIR, BGM_TRACKS, SHUFFLE_VALUE } from "../common/bgmTracks";
import usePlaybackState from "../common/hooks/usePlaybackState";

interface Props {
  trackFilename: string | null;
  volume: number;
}

// BGM eases in from silence after a song ends instead of slamming to full
// volume, crosses track switches with a fade-out/fade-in, and ducks away
// quickly when the next song starts. Same-track looping is untouched.
const FADE_IN_MS = 2000;
const TRACK_SWITCH_FADE_OUT_MS = 1200;
const SONG_START_FADE_OUT_MS = 400;

function pickRandomTrack(excludeFilename?: string): string {
  const candidates = BGM_TRACKS.filter((t) => t.filename !== excludeFilename);
  const pool = candidates.length > 0 ? candidates : BGM_TRACKS;
  return pool[Math.floor(Math.random() * pool.length)].filename;
}

export default function BackgroundMusic({ trackFilename, volume }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { playbackState } = usePlaybackState();
  const isShuffling = trackFilename === SHUFFLE_VALUE;

  // While shuffling, this holds whichever real track is currently playing;
  // it's swapped out for another random pick each time that track ends.
  const [shuffledFilename, setShuffledFilename] = useState<string | null>(null);

  useEffect(() => {
    if (isShuffling) setShuffledFilename(pickRandomTrack());
  }, [isShuffling]);

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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
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
      onEnded={
        isShuffling
          ? () => setShuffledFilename(pickRandomTrack(mountedFilename))
          : undefined
      }
    />
  );
}
