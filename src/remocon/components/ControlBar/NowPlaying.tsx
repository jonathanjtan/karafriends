import React from "react";

import useNowPlaying from "../../hooks/useNowPlaying";
import useUserIdentity from "../../hooks/useUserIdentity";
import SongQueueItem from "../SongQueue/SongQueueItem";
import * as styles from "./ControlBar.module.scss";

// Takes the song from ControlBar, which also needs it for the lyrics button,
// rather than opening a second now-playing subscription of its own.
const NowPlaying = ({
  currentSong,
}: {
  currentSong: ReturnType<typeof useNowPlaying>;
}) => {
  const { nickname } = useUserIdentity();

  return (
    <div className={styles.nowPlaying}>
      {currentSong && (
        <>
          <div className={styles.nowPlayingPrefix}>
            <span className={styles.nowPlayingPrefixEn}>Now Playing: </span>
            <span className={styles.nowPlayingPrefixJa}>演奏中の曲: </span>
          </div>
          <div className={styles.nowPlayingSong}>
            <SongQueueItem
              item={currentSong}
              eta={0}
              myNickname={nickname}
              isCurrent={true}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default NowPlaying;
