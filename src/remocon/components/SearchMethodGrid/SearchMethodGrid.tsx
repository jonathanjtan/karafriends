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
import TuningGridItem from "./TuningGridItem";

// Title and Artist each search both catalogs at once, so they're one row of
// two rather than a per-service block — the service a result came from is a
// badge on the row and a filter chip above the list, not a decision you make
// before typing. The brand banners survive on the charts below, which really
// are per-service: DAM and JOYSOUND publish different Top 100s.
const SearchMethodGrid = () => (
  <div>
    <h2>Find a song</h2>
    <div className={styles.grid}>
      <div className={styles.searchSection}>
        <SearchMethodGridItem method="song" text="Title" />
        <SearchMethodGridItem method="artist" text="Artist" />
      </div>
      <div className={styles.rankingSection}>
        <div className={classnames(styles.serviceBanner, styles.joysound)}>
          <img src={joysoundLogo} alt="JOYSOUND" />
        </div>
        <RankingGridItem service="joysound" />
      </div>
      <div className={styles.rankingSection}>
        <div className={classnames(styles.serviceBanner, styles.dam)}>
          <img src={damLogo} alt="DAM" />
        </div>
        <RankingGridItem service="dam" />
      </div>
      <div className={styles.mediaSection}>
        <OriconGridItem />
        <SearchMethodGridItem method="youtube" text="YouTube" />
        <SearchMethodGridItem method="niconico" text="Niconico" />
      </div>
      {/* Its own row: it is not a way to find a song, and putting it in the
          media row would have made that row four columns on a phone. */}
      <div className={styles.warmupSection}>
        <TuningGridItem />
      </div>
    </div>
  </div>
);

export default SearchMethodGrid;
