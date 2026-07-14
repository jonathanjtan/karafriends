import React from "react";

import RankingGridItem from "./RankingGridItem";
import * as styles from "./SearchMethodGrid.module.scss";
import SearchMethodGridItem from "./SearchMethodGridItem";

const SearchMethodGrid = () => (
  <div>
    <h2>Find a song</h2>
    <div className={styles.grid}>
      <SearchMethodGridItem method="joysoundSong" text="Title" />
      <SearchMethodGridItem method="joysoundArtist" text="Artist" />
      <RankingGridItem service="joysound" />
      <SearchMethodGridItem method="song" text="Title" />
      <SearchMethodGridItem method="artist" text="Artist" />
      <RankingGridItem service="dam" />
      <SearchMethodGridItem method="youtube" text="YouTube" />
      <SearchMethodGridItem method="niconico" text="Niconico" />
    </div>
  </div>
);

export default SearchMethodGrid;
