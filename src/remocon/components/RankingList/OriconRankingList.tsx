import React from "react";
import { Link } from "react-router";

import { OriconChartEntry } from "../../../common/oriconChart";
import { List, ListItem } from "../List";
import * as styles from "./RankingList.module.scss";

interface Props {
  songs: ReadonlyArray<OriconChartEntry>;
  // Where a tapped row goes to look itself up in the services' catalogs; the
  // song's title and artist are appended for the lookup page to search on and
  // display.
  linkBase: string;
}

const medalClasses: { [rank: number]: string } = {
  1: styles.gold,
  2: styles.silver,
  3: styles.bronze,
};

// Oricon rows carry no catalog ids and no readings — it's a third-party
// chart, so there's nothing to link straight to and no yomi to romanize
// (hence no WeebText here, unlike RankingList). Every row is tappable: the
// lookup that finds the singable song runs on the next page, not now.
const OriconRankingList = ({ songs, linkBase }: Props) => (
  <List>
    {songs.map((song) => (
      <Link
        key={song.rank}
        to={`${linkBase}/${encodeURIComponent(
          song.name,
        )}/${encodeURIComponent(song.artistName)}`}
      >
        <ListItem>
          <div className={styles.item}>
            <span className={`${styles.rank} ${medalClasses[song.rank] || ""}`}>
              {song.rank}
            </span>
            <div>
              <div className={styles.oriconName}>{song.name}</div>
              <div>{song.artistName}</div>
            </div>
          </div>
        </ListItem>
      </Link>
    ))}
  </List>
);

export default OriconRankingList;
