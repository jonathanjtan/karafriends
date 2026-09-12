import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { MdLyrics } from "react-icons/md";

import useLyricsPanelOpen from "../../hooks/useLyricsPanelOpen";
import * as styles from "./LyricsToggle.module.scss";

// Shows and hides the now-playing lyrics panel. Lives beside "Now Playing"
// because that's what it's the lyrics of; the control bar only renders it
// while the current song has lyrics to show.
const LyricsToggle = () => {
  const [open, setOpen] = useLyricsPanelOpen();

  return (
    <button
      type="button"
      className={classnames(styles.lyricsToggle, { [styles.on]: open })}
      aria-label={open ? "Hide lyrics" : "Show lyrics"}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    >
      <MdLyrics />
    </button>
  );
};

export default LyricsToggle;
