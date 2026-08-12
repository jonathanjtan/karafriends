import React from "react";
import { Link } from "react-router";

import { ListItem } from "../List";
import * as styles from "./KaraokeChannelSearchResults.module.scss";
import { KaraokeChannelSearchResultsQuery$data } from "./__generated__/KaraokeChannelSearchResultsQuery.graphql";

type Props =
  KaraokeChannelSearchResultsQuery$data["karaokeChannelSongs"]["songs"][0];

// These rows are YouTube videos, so they open the YouTube page and queue
// through the ordinary YouTube path -- no new detail route, no new mutation.
// The parsed song and artist ride along in router state: without them the
// queue and the song history record the raw video title ("[TJ노래방] 하루하루
// - 빅뱅(BIGBANG) / TJ Karaoke") as the song name, which is exactly the mess
// this search exists to clean up.
const KaraokeChannelSearchResultsItem = ({
  videoId,
  channelLabel,
  name,
  artistName,
  variant,
  catalogId,
}: Props) => (
  <Link
    to={`/search/youtube/${videoId}`}
    state={{ name, artistName }}
    className={styles.link}
  >
    <ListItem>
      <div className={styles.item}>
        <div className={styles.text}>
          <div className={styles.name}>{name}</div>
          <div className={styles.artist}>{artistName}</div>
        </div>
        <div className={styles.tags}>
          {variant ? <span className={styles.variant}>{variant}</span> : null}
          <span className={styles.channel}>
            {channelLabel}
            {catalogId ? ` · ${catalogId}` : ""}
          </span>
        </div>
      </div>
    </ListItem>
  </Link>
);

export default KaraokeChannelSearchResultsItem;
