import React from "react";
import { Link } from "react-router";

import { ListItem } from "../List";
import WeebText from "../WeebText";
import { JoysoundArtist_joysoundSongsByArtist$data } from "./__generated__/JoysoundArtist_joysoundSongsByArtist.graphql";

type Props =
  JoysoundArtist_joysoundSongsByArtist$data["joysoundSongsByArtist"]["edges"][0]["node"];

const JoysoundArtistSongItem = ({ id, name, nameYomi }: Props) => (
  <Link to={`/joysoundSong/${id}`}>
    <ListItem>
      <WeebText bold text={name} yomi={nameYomi} />
    </ListItem>
  </Link>
);

export default JoysoundArtistSongItem;
