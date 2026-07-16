import React from "react";
import { Link } from "react-router";

import { ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./JoysoundArtistSearchResults.module.scss";
import { JoysoundArtistSearchResults_joysoundArtistsByKeyword$data } from "./__generated__/JoysoundArtistSearchResults_joysoundArtistsByKeyword.graphql";

type Props =
  JoysoundArtistSearchResults_joysoundArtistsByKeyword$data["joysoundArtistsByKeyword"]["edges"][0]["node"];

const JoysoundArtistSearchResultsItem = ({ id, name, nameYomi }: Props) => (
  <Link to={`/joysoundArtist/${id}`}>
    <ListItem>
      <WeebText bold text={name} yomi={nameYomi} />
    </ListItem>
  </Link>
);

export default JoysoundArtistSearchResultsItem;
