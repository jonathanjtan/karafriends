import React from "react";
import { Link } from "react-router";

import { ListItem } from "../List";
import WeebText from "../WeebText";
import { JoysoundSongSearchResults_joysoundSongsByKeyword$data } from "./__generated__/JoysoundSongSearchResults_joysoundSongsByKeyword.graphql";

type Props =
  JoysoundSongSearchResults_joysoundSongsByKeyword$data["joysoundSongsByKeyword"]["edges"][0]["node"];

const SongSearchResultsItem = ({
  id,
  name,
  nameYomi,
  artistName,
  artistNameYomi,
}: Props) => (
  <Link to={`/joysoundSong/${id}`}>
    <ListItem>
      <div>
        <WeebText bold text={name} yomi={nameYomi} />
      </div>
      <div>
        <WeebText text={artistName} yomi={artistNameYomi} />
      </div>
    </ListItem>
  </Link>
);

export default SongSearchResultsItem;
