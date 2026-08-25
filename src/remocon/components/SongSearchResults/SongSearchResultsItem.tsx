import React from "react";
import { Link } from "react-router";

import SourceBadge from "../../../common/components/SourceBadge";
import { ListItem } from "../List";
import WeebText from "../WeebText";
import * as styles from "./SongSearchResults.module.scss";
import { SongSearchResults_searchSongs$data } from "./__generated__/SongSearchResults_searchSongs.graphql";

type Props =
  SongSearchResults_searchSongs$data["searchSongs"]["edges"][0]["node"] & {
    // True only when this song would sit nicely for whoever is holding the
    // phone. There is deliberately no falsy counterpart to render. False and
    // "we have no idea" are the same thing here, and both show nothing.
    comfortable?: boolean;
  };

// The two catalogs' song pages are separate routes. They queue through
// different mutations and only JOYSOUND takes a background MV, so a merged
// row still opens its own service's page. `songId` rather than `id` because
// `id` is source-qualified for Relay's benefit (see schema.graphql).
const SongSearchResultsItem = ({
  songId,
  source,
  name,
  nameYomi,
  artistName,
  artistNameYomi,
  comfortable,
}: Props) => (
  <Link
    to={source === "JOYSOUND" ? `/joysoundSong/${songId}` : `/song/${songId}`}
  >
    <ListItem>
      <div className={styles.item}>
        <div className={styles.text}>
          <div>
            <WeebText bold text={name} yomi={nameYomi} />
          </div>
          <div>
            <WeebText text={artistName} yomi={artistNameYomi} />
          </div>
        </div>
        {comfortable ? (
          <span className={styles.comfortable} title="should sit comfortably">
            ♪
          </span>
        ) : null}
        <SourceBadge typename={source} fontSize="11px" />
      </div>
    </ListItem>
  </Link>
);

export default SongSearchResultsItem;
