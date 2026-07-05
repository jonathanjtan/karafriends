import React, { useEffect, useRef, useState } from "react";

import usePlaybackState from "../common/hooks/usePlaybackState";
import { BGM_DIR, BGM_TRACKS, SHUFFLE_VALUE } from "./bgmTracks";

interface Props {
  trackFilename: string | null;
  volume: number;
}

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

  const activeFilename = isShuffling ? shuffledFilename : trackFilename;
  const shouldPlay = activeFilename !== null && playbackState === "WAITING";

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [activeFilename, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (shouldPlay) {
      audio.play().catch((e) => console.warn("BGM autoplay failed", e));
    } else {
      audio.pause();
    }
  }, [activeFilename, shouldPlay]);

  if (!activeFilename) return null;
  // key={activeFilename} forces React to fully remount the element (instead
  // of just updating its src in place) when switching tracks — Chromium
  // doesn't pick up a new src on an already-loaded <audio> element without
  // an explicit load() call, so without this, switching tracks silently
  // kept playing whatever was already loaded.
  return (
    <audio
      key={activeFilename}
      ref={audioRef}
      src={`${BGM_DIR}${activeFilename}`}
      loop={!isShuffling}
      onEnded={
        isShuffling
          ? () => setShuffledFilename(pickRandomTrack(activeFilename))
          : undefined
      }
    />
  );
}
