import classnames from "classnames";
import React from "react";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import damLogo from "url:../../images/dam-logo.png";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import joysoundLogo from "url:../../images/joysound-logo.svg";
import OriconGridItem from "./OriconGridItem";
import RankingGridItem from "./RankingGridItem";
import * as styles from "./SearchMethodGrid.module.scss";
import SearchMethodGridItem from "./SearchMethodGridItem";

// Each service gets a thin vertical brand banner running down the left of
// its section, spanning both the Title/Artist row and the TOP 100 row. The
// last section has no banner and no catalog behind it — Oricon, YouTube and
// Niconico share a full-width row of three.
const SearchMethodGrid = () => (
  <div>
    <h2>Find a song</h2>
    <div className={styles.grid}>
      <div className={styles.serviceSection}>
        <div className={classnames(styles.serviceBanner, styles.joysound)}>
          <img src={joysoundLogo} alt="JOYSOUND" />
        </div>
        <SearchMethodGridItem method="joysoundSong" text="Title" />
        <SearchMethodGridItem method="joysoundArtist" text="Artist" />
        <div className={styles.rankingRowSizer} aria-hidden="true" />
        <RankingGridItem service="joysound" />
      </div>
      <div className={styles.serviceSection}>
        <div className={classnames(styles.serviceBanner, styles.dam)}>
          <img src={damLogo} alt="DAM" />
        </div>
        <SearchMethodGridItem method="song" text="Title" />
        <SearchMethodGridItem method="artist" text="Artist" />
        <div className={styles.rankingRowSizer} aria-hidden="true" />
        <RankingGridItem service="dam" />
      </div>
      <div className={styles.mediaSection}>
        <OriconGridItem />
        <SearchMethodGridItem method="youtube" text="YouTube" />
        <SearchMethodGridItem method="niconico" text="Niconico" />
      </div>
    </div>
  </div>
);

export default SearchMethodGrid;
