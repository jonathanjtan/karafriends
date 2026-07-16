import React from "react";
import { Link } from "react-router";

import { ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./JoysoundArtistSearchResults.module.scss";
import { JoysoundArtistSearchResults_joysoundArtistsByKeyword$data } from "./__generated__/JoysoundArtistSearchResults_joysoundArtistsByKeyword.graphql";

type Props =
  JoysoundArtistSearchResults_joysoundArtistsByKeyword$data["joysoundArtistsByKeyword"]["edges"][0]["node"];

// The song count is capped server-side (see getJoysoundArtistSongCount in
// main/graphql.ts) since JOYSOUND's API exposes no true total; a count that
// hit the cap is shown as an underestimate rather than an exact number.
const SONG_COUNT_CAP = 200;

const JoysoundArtistSearchResultsItem = ({
  id,
  name,
  nameYomi,
  songCount,
}: Props) => (
  <Link to={`/joysoundArtist/${id}`}>
    <ListItem>
      <WeebText bold text={name} yomi={nameYomi} />
      <span className={styles.songCount}>
        {songCount}
        {songCount === SONG_COUNT_CAP ? "+" : ""}{" "}
        {songCount === 1 ? "song" : "songs"}
      </span>
    </ListItem>
  </Link>
);

export default JoysoundArtistSearchResultsItem;
