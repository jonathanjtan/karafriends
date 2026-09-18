import React, { useState } from "react";
// tslint:disable-next-line:no-submodule-imports
import { BsMusicPlayerFill } from "react-icons/bs";
// tslint:disable-next-line:no-submodule-imports
import { FaAngleDown, FaAngleUp, FaSmile } from "react-icons/fa";

import { queueItemKey } from "../../../common/telopLayout";
import useLyricsPanelOpen from "../../hooks/useLyricsPanelOpen";
import useNowPlaying from "../../hooks/useNowPlaying";
import accessibleClick from "../accessibleClick";
import Collapse from "../Collapse";
import EmoteButtons from "../EmoteButtons";
import NowPlayingLyrics, { LyricsToggle } from "../NowPlayingLyrics";
import PlaybackControls from "../PlaybackControls";
import Reveal from "../Reveal";
import SongQueue from "../SongQueue";
import * as styles from "./ControlBar.module.scss";
import NowPlaying from "./NowPlaying";

const ControlBar = () => {
  const currentSong = useNowPlaying();
  const [lyricsOpen] = useLyricsPanelOpen();

  // JOYSOUND is the only source with timed lyrics to mirror: DAM burns its
  // lyrics into the video, and YouTube/Niconico are music videos.
  const lyricsSongKey =
    currentSong?.__typename === "JoysoundQueueItem" &&
    currentSong.songId !== undefined &&
    currentSong.timestamp !== undefined
      ? queueItemKey({
          songId: currentSong.songId,
          timestamp: currentSong.timestamp,
        })
      : null;

  const [expanded, _setExpanded] = useState(
    localStorage.getItem("expanded") === "true" || false,
  );
  const [showEmotes, _setShowEmotes] = useState(
    localStorage.getItem("showEmotes") === "true" || false,
  );

  const setExpanded = (value: boolean) => {
    localStorage.setItem("expanded", value.toString());
    _setExpanded(value);
  };

  const setShowEmotes = (value: boolean) => {
    localStorage.setItem("showEmotes", value.toString());
    _setShowEmotes(value);
  };

  return (
    <div className={styles.controlBar}>
      <Reveal open={lyricsOpen && lyricsSongKey !== null}>
        {lyricsSongKey !== null ? (
          // Keyed by song so a new song starts from a clean panel (no carried
          // over wipe position, full screen, or rasterized blocks).
          <NowPlayingLyrics key={lyricsSongKey} songKey={lyricsSongKey} />
        ) : null}
      </Reveal>
      <div className={styles.expander}>
        <NowPlaying currentSong={currentSong} />
        <div className={styles.expanderButtons}>
          {lyricsSongKey !== null ? <LyricsToggle /> : null}
          <div
            {...accessibleClick(() => setExpanded(!expanded), {
              ariaLabel: expanded ? "Collapse controls" : "Expand controls",
            })}
          >
            {expanded ? <FaAngleDown /> : <FaAngleUp />}
          </div>
        </div>
      </div>
      <Collapse open={expanded} direction="up" className={styles.drawer}>
        <div className={styles.drawerContent}>
          <div className={styles.queue}>
            <SongQueue />
          </div>
          <div
            className={styles.toggle}
            {...accessibleClick(() => setShowEmotes(!showEmotes), {
              ariaLabel: showEmotes ? "Show playback controls" : "Show emotes",
            })}
          >
            {showEmotes ? <BsMusicPlayerFill /> : <FaSmile />}
          </div>
          <div className={styles.controls}>
            {showEmotes ? <EmoteButtons /> : <PlaybackControls />}
          </div>
        </div>
      </Collapse>
    </div>
  );
};

export default ControlBar;
