import classnames from "classnames";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
// tslint:disable-next-line:no-submodule-imports
import { MdCloseFullscreen, MdOpenInFull, MdShowChart } from "react-icons/md";

import {
  getTelopLyricsBounds,
  TELOP_TIMING_OFFSET_MS,
} from "../../../common/telopLayout";
import useCurrentSongPianoRoll from "../../hooks/useCurrentSongPianoRoll";
import useCurrentSongTelop from "../../hooks/useCurrentSongTelop";
import usePlaybackClock from "../../hooks/usePlaybackClock";
import useServerClockOffset from "../../hooks/useServerClockOffset";
import * as styles from "./NowPlayingLyrics.module.scss";
import PianoRollCanvas from "./PianoRollCanvas";
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

// Whether this phone shows the piano roll above the lyrics. Per-device, like
// the lyrics panel itself: it's about how much of this screen the singer wants
// spent on what.
const SHOW_ROLL_KEY = "showLyricsPianoRoll";

function readShowRoll(): boolean {
  try {
    return localStorage.getItem(SHOW_ROLL_KEY) !== "false";
  } catch {
    return true;
  }
}

// The current JOYSOUND song's lyrics, drawn exactly as the TV draws them and
// kept on the TV's clock: the phone's clock is mapped onto main's
// (useServerClockOffset), and the TV's last reported position is extrapolated
// along it (usePlaybackClock). The piano roll above them is the same story
// with a different payload: the TV's layout, and the pitch values it plotted.
const NowPlayingLyrics = (props: { songKey: string }) => {
  const { songKey } = props;
  const telop = useCurrentSongTelop(songKey);
  const roll = useCurrentSongPianoRoll(songKey);
  const clockRef = usePlaybackClock();
  const offsetRef = useServerClockOffset();
  const [fullscreen, setFullscreen] = useState(false);
  const [showRoll, setShowRoll] = useState(readShowRoll);
  const lastPositionRef = useRef<{
    songKey: string;
    positionMs: number;
  } | null>(null);

  // Where the TV's player is right now, on this phone's clock. Null until both
  // the TV's report and the clock offset have landed.
  const mediaTimeMs = useCallback((): number | null => {
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

    return positionMs;
  }, [songKey]);

  const lyricTime = useCallback((): number | null => {
    const positionMs = mediaTimeMs();
    return positionMs === null ? null : positionMs + TELOP_TIMING_OFFSET_MS;
  }, [mediaTimeMs]);

  // The roll scrolls off the raw media clock in seconds, exactly as the big
  // screen's does. The telop's lead above is a telop thing and must not reach
  // this.
  const rollTime = useCallback((): number | null => {
    const positionMs = mediaTimeMs();
    return positionMs === null ? null : positionMs / 1000;
  }, [mediaTimeMs]);

  const aspectRatio = useMemo(() => {
    if (telop.status !== "ready") return PLACEHOLDER_ASPECT;
    const crop = getTelopLyricsBounds(telop.layout);
    return `${crop.width} / ${crop.height}`;
  }, [telop]);

  const toggleRoll = (next: boolean) => {
    setShowRoll(next);
    try {
      localStorage.setItem(SHOW_ROLL_KEY, String(next));
    } catch {
      // Private mode and friends: the toggle still works for this visit.
    }
  };

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

  // Only offered for songs whose guide melody the TV actually has: an
  // unscored song has no roll on the big screen either.
  const rollReady = roll.status === "ready";

  const stage = (
    <div
      className={classnames(
        fullscreen ? styles.fullscreenStage : styles.dockedStage,
        { [styles.withRoll]: rollReady && showRoll },
      )}
    >
      {roll.status === "ready" && showRoll ? (
        <PianoRollCanvas
          songKey={songKey}
          layout={roll.layout}
          micCount={roll.micCount}
          rollTime={rollTime}
        />
      ) : null}
      <div
        className={styles.lyricsStage}
        style={fullscreen ? undefined : { aspectRatio }}
      >
        {content}
      </div>
      {fullscreen ? (
        <p className={styles.rotateHint}>
          Turn your phone sideways for bigger lyrics
        </p>
      ) : null}
      <div className={styles.stageButtons}>
        {rollReady ? (
          <button
            type="button"
            className={classnames(styles.stageButton, {
              [styles.stageButtonOn]: showRoll,
            })}
            aria-label={
              showRoll ? "Hide the piano roll" : "Show the piano roll"
            }
            aria-pressed={showRoll}
            onClick={() => toggleRoll(!showRoll)}
          >
            <MdShowChart />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.stageButton}
          aria-label={
            fullscreen ? "Exit full screen lyrics" : "Full screen lyrics"
          }
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? <MdCloseFullscreen /> : <MdOpenInFull />}
        </button>
      </div>
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
