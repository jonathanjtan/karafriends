import React, { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// tslint:disable-next-line:no-submodule-imports
import { MdCloseFullscreen, MdOpenInFull } from "react-icons/md";

import {
  getTelopLyricsBounds,
  TELOP_TIMING_OFFSET_MS,
} from "../../../common/telopLayout";
import useCurrentSongTelop from "../../hooks/useCurrentSongTelop";
import usePlaybackClock from "../../hooks/usePlaybackClock";
import useServerClockOffset from "../../hooks/useServerClockOffset";
import * as styles from "./NowPlayingLyrics.module.scss";
import TelopCanvas from "./TelopCanvas";

// The shape of JOYSOUND's usual lyrics band (see getTelopLyricsBounds), for
// the panel to hold while a song's layout is still on its way, so it doesn't
// jump in height when the lyrics arrive.
const PLACEHOLDER_ASPECT = "568 / 298";

// A report can land a few ms behind where this phone had already
// extrapolated to (the TV's clock reads jitter by that much). Holding still
// for those few ms is invisible; a wipe stepping backwards isn't. Anything
// bigger is a real seek and is followed.
const BACKWARD_JITTER_MS = 50;

// The current JOYSOUND song's lyrics, drawn exactly as the TV draws them and
// kept on the TV's clock: the phone's clock is mapped onto main's
// (useServerClockOffset), and the TV's last reported position is extrapolated
// along it (usePlaybackClock).
const NowPlayingLyrics = (props: { songKey: string }) => {
  const { songKey } = props;
  const telop = useCurrentSongTelop(songKey);
  const clockRef = usePlaybackClock();
  const offsetRef = useServerClockOffset();
  const [fullscreen, setFullscreen] = useState(false);
  const lastPositionRef = useRef<{
    songKey: string;
    positionMs: number;
  } | null>(null);

  const lyricTime = useCallback((): number | null => {
    const clock = clockRef.current;
    const { offsetMs } = offsetRef.current;
    if (clock === null || clock.songKey !== songKey || offsetMs === null) {
      return null;
    }

    const serverNow = Date.now() + offsetMs;
    let positionMs = clock.playing
      ? clock.positionMs + (serverNow - clock.capturedAt) * clock.rate
      : clock.positionMs;

    const last = lastPositionRef.current;
    if (
      clock.playing &&
      last !== null &&
      last.songKey === songKey &&
      positionMs < last.positionMs &&
      last.positionMs - positionMs < BACKWARD_JITTER_MS
    ) {
      positionMs = last.positionMs;
    }
    lastPositionRef.current = { songKey, positionMs };

    return positionMs + TELOP_TIMING_OFFSET_MS;
  }, [songKey]);

  const aspectRatio = useMemo(() => {
    if (telop.status !== "ready") return PLACEHOLDER_ASPECT;
    const crop = getTelopLyricsBounds(telop.layout);
    return `${crop.width} / ${crop.height}`;
  }, [telop]);

  let content: React.ReactNode;
  switch (telop.status) {
    case "ready":
      content = (
        <TelopCanvas
          layout={telop.layout}
          lyricTime={lyricTime}
          className={styles.canvas}
        />
      );
      break;
    case "loading":
      content = <p className={styles.message}>Loading lyrics…</p>;
      break;
    case "unavailable":
      content = (
        <p className={styles.message}>
          The TV couldn&apos;t lay out lyrics for this song.
        </p>
      );
      break;
    case "incompatible":
      content = (
        <p className={styles.message}>
          The TV is running a newer karafriends. Reload this page to see lyrics.
        </p>
      );
      break;
  }

  const stage = (
    <div
      className={fullscreen ? styles.fullscreenStage : styles.dockedStage}
      style={fullscreen ? undefined : { aspectRatio }}
    >
      {content}
      {fullscreen ? (
        <p className={styles.rotateHint}>
          Turn your phone sideways for bigger lyrics
        </p>
      ) : null}
      <button
        type="button"
        className={styles.fullscreenButton}
        aria-label={
          fullscreen ? "Exit full screen lyrics" : "Full screen lyrics"
        }
        onClick={() => setFullscreen(!fullscreen)}
      >
        {fullscreen ? <MdCloseFullscreen /> : <MdOpenInFull />}
      </button>
    </div>
  );

  // Full screen is an overlay on the whole page rather than the Fullscreen
  // API, which iPhone Safari only grants to <video>. Turn the phone sideways
  // and the lyrics fill it.
  return fullscreen ? (
    createPortal(
      <div className={styles.fullscreen}>{stage}</div>,
      document.body,
    )
  ) : (
    <div className={styles.panel}>{stage}</div>
  );
};

export default NowPlayingLyrics;
