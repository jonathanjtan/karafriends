import React from "react";
import { Link } from "react-router";

import { List, ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./RankingList.module.scss";

export interface RankingArtistData {
  readonly rank: number;
  // Null only if a parse ever misses the id; the artist charts carry ids that
  // map straight to the catalog, so this is effectively always present.
  readonly artistId: string | null | undefined;
  readonly name: string;
  readonly nameYomi: string;
}

interface Props {
  artists: ReadonlyArray<RankingArtistData>;
  // Artist-page route prefix entries link under: /joysoundArtist or /artist.
  linkBase: string;
}

const medalClasses: { [rank: number]: string } = {
  1: styles.gold,
  2: styles.silver,
  3: styles.bronze,
};

const RankingArtistItem = ({ artist }: { artist: RankingArtistData }) => (
  <ListItem>
    <div className={styles.item}>
      <span className={`${styles.rank} ${medalClasses[artist.rank] || ""}`}>
        {artist.rank}
      </span>
      <div>
        <WeebText bold text={artist.name} yomi={artist.nameYomi} />
      </div>
    </div>
  </ListItem>
);

const RankingArtistList = ({ artists, linkBase }: Props) => (
  <List>
    {artists.map((artist) =>
      artist.artistId ? (
        <Link key={artist.rank} to={`${linkBase}/${artist.artistId}`}>
          <RankingArtistItem artist={artist} />
        </Link>
      ) : (
        <div key={artist.rank} className={styles.unavailable}>
          <RankingArtistItem artist={artist} />
        </div>
      ),
    )}
  </List>
);

export default RankingArtistList;
