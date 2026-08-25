import React from "react";
import { useParams } from "react-router";

import { oriconSearchQuery } from "../../common/oriconChart";
import SongSearchResults from "../components/SongSearchResults";
import * as styles from "./OriconRankingPage.module.scss";

type OriconSongParams = {
  query: string;
  artist?: string;
};

// Where an Oricon chart row cashes out into something singable. Nothing is
// queried until someone lands here: the chart itself is a bundled table, and
// this page is the first thing that talks to DAM or JOYSOUND.
//
// Both services are searched by the charted title. The Oricon artist is shown
// rather than used to filter, because the three sources spell credits
// differently ("WhiteFlame feat.初音ミク" vs the catalogs' own forms). A
// strict artist match would hide real results, so the caller picks instead.
// This used to be two per-service lists under two headings; the merged search
// covers the same ground in one ranked list, and carries the same "one
// service being unreachable still leaves the other usable" property in its
// unavailableSources notice.
const OriconSongPage = () => {
  const params = useParams<OriconSongParams>();
  const charted = params.query ? decodeURIComponent(params.query) : null;
  const artist = params.artist ? decodeURIComponent(params.artist) : null;
  // The charted title is what's shown; the catalogs are searched for a
  // de-annotated form of it.
  const query = charted === null ? null : oriconSearchQuery(charted);

  return (
    <>
      <h2>Find this song</h2>
      <p className={styles.lookupHeader}>
        Oricon lists this as{" "}
        <span className={styles.lookupTitle}>{charted}</span>
        {artist ? ` by ${artist}` : null}. Pick the matching entry below to
        queue it.
      </p>

      <SongSearchResults query={query} />
    </>
  );
};

export default OriconSongPage;
