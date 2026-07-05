import React, { useEffect, useRef } from "react";

import usePlaybackState from "../common/hooks/usePlaybackState";
import { BGM_DIR } from "./bgmTracks";

interface Props {
  trackFilename: string | null;
  volume: number;
}

export default function BackgroundMusic({ trackFilename, volume }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { playbackState } = usePlaybackState();
  const shouldPlay = trackFilename !== null && playbackState === "WAITING";

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [trackFilename, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (shouldPlay) {
      audio.play().catch((e) => console.warn("BGM autoplay failed", e));
    } else {
      audio.pause();
    }
  }, [trackFilename, shouldPlay]);

  if (!trackFilename) return null;
  // key={trackFilename} forces React to fully remount the element (instead
  // of just updating its src in place) when switching tracks — Chromium
  // doesn't pick up a new src on an already-loaded <audio> element without
  // an explicit load() call, so without this, switching tracks silently
  // kept playing whatever was already loaded.
  return (
    <audio
      key={trackFilename}
      ref={audioRef}
      src={`${BGM_DIR}${trackFilename}`}
      loop
    />
  );
}
