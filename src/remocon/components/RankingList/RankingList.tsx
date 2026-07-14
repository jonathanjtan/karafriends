import React from "react";
import { Link } from "react-router";

import { List, ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./RankingList.module.scss";

export interface RankingSongData {
  readonly rank: number;
  // Null when the charted song isn't in the service's singable catalog;
  // those rows render unlinked so the chart still reads as a full Top 100.
  readonly id: string | null | undefined;
  readonly name: string;
  readonly nameYomi: string;
  readonly artistName: string;
  readonly artistNameYomi: string;
}

interface Props {
  songs: ReadonlyArray<RankingSongData>;
  // Song-page route prefix the entries link under: /joysoundSong or /song.
  linkBase: string;
}

const medalClasses: { [rank: number]: string } = {
  1: styles.gold,
  2: styles.silver,
  3: styles.bronze,
};

const RankingListItem = ({ song }: { song: RankingSongData }) => (
  <ListItem>
    <div className={styles.item}>
      <span className={`${styles.rank} ${medalClasses[song.rank] || ""}`}>
        {song.rank}
      </span>
      <div>
        <div>
          <WeebText bold text={song.name} yomi={song.nameYomi} />
        </div>
        <div>
          <WeebText text={song.artistName} yomi={song.artistNameYomi} />
        </div>
      </div>
    </div>
  </ListItem>
);

const RankingList = ({ songs, linkBase }: Props) => (
  <List>
    {songs.map((song) =>
      song.id ? (
        <Link key={song.rank} to={`${linkBase}/${song.id}`}>
          <RankingListItem song={song} />
        </Link>
      ) : (
        <div key={song.rank} className={styles.unavailable}>
          <RankingListItem song={song} />
        </div>
      ),
    )}
  </List>
);

export default RankingList;
