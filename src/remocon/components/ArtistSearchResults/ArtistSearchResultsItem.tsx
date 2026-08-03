import React from "react";
import { Link } from "react-router";

import SourceBadge from "../../../common/components/SourceBadge";
import { ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./ArtistSearchResults.module.scss";
import { ArtistSearchResults_searchArtists$data } from "./__generated__/ArtistSearchResults_searchArtists.graphql";

type Props =
  ArtistSearchResults_searchArtists$data["searchArtists"]["edges"][0]["node"];

// JOYSOUND publishes no artist total, so its count is a capped tally of the
// artist's song list (see getJoysoundArtistSongCount in main/graphql.ts) and
// a count that hit the cap is shown as an underestimate. DAM reports a real
// total, so it never wears the "+".
const JOYSOUND_SONG_COUNT_CAP = 200;

const ArtistSearchResultsItem = ({
  artistId,
  source,
  name,
  nameYomi,
  songCount,
}: Props) => (
  <Link
    to={
      source === "JOYSOUND"
        ? `/joysoundArtist/${artistId}`
        : `/artist/${artistId}`
    }
  >
    <ListItem>
      <div className={styles.item}>
        <div className={styles.text}>
          <WeebText bold text={name} yomi={nameYomi} />
          <span className={styles.songCount}>
            {songCount}
            {source === "JOYSOUND" && songCount === JOYSOUND_SONG_COUNT_CAP
              ? "+"
              : ""}{" "}
            {songCount === 1 ? "song" : "songs"}
          </span>
        </div>
        <SourceBadge typename={source} fontSize="11px" />
      </div>
    </ListItem>
  </Link>
);

export default ArtistSearchResultsItem;
