import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./ComfortableHint.module.scss";
import { ComfortableHintQuery } from "./__generated__/ComfortableHintQuery.graphql";

// How a song sits for whoever is holding the phone, if we happen to know.
//
// **Positive-only, and silent by default.** There are exactly two things this
// can say: "this should sit comfortably", or "-2 would be easier on your
// voice". There is no "too high", no warning, no discouragement, and no state
// that suggests somebody shouldn't sing something. Rendering nothing is the
// common case and always an acceptable one -- no measured range, no cached song
// range, an unremarkable fit, they all collapse to the same silence.
//
// It never replaces or disables the normal queue button; it sits beside it.
const comfortableHintQuery = graphql`
  query ComfortableHintQuery(
    $source: SongSource!
    $songId: String!
    $allowFetch: Boolean
    $nickname: String
    $personId: String
  ) {
    songVocalRange(
      source: $source
      songId: $songId
      allowFetch: $allowFetch
      nickname: $nickname
      personId: $personId
    ) {
      fit {
        comfortable
        suggestedShiftSemis
      }
    }
  }
`;

interface Props {
  source: "DAM" | "JOYSOUND";
  songId: string;
  // A song detail page is one song the user deliberately opened, so it may pay
  // for a fetch on a cache miss. List surfaces must leave this false.
  allowFetch?: boolean;
  // Rendered when a shift is suggested, so the caller can offer queueing at
  // that key without this component knowing anything about queueing.
  renderShiftAction?: (semis: number) => React.ReactNode;
}

const ComfortableHint = ({
  source,
  songId,
  allowFetch,
  renderShiftAction,
}: Props) => {
  const identity = useUserIdentity();
  const data = useLazyLoadQuery<ComfortableHintQuery>(
    comfortableHintQuery,
    {
      source,
      songId,
      allowFetch: allowFetch ?? false,
      nickname: identity.nickname,
      personId: identity.personId,
    },
    // A hint is a nicety and the answer barely changes; don't re-run it on
    // every mount of a page somebody is flicking back and forth to.
    { fetchPolicy: "store-or-network" },
  );

  const fit = data.songVocalRange.fit;
  if (fit === null || fit === undefined) return null;

  if (fit.comfortable) {
    return (
      <div className={styles.comfortable}>this one should sit comfortably</div>
    );
  }

  const semis = fit.suggestedShiftSemis;
  if (semis === null || semis === undefined) return null;

  return (
    <div className={styles.suggestion}>
      <span>
        {semis > 0 ? `+${semis}` : semis} would be easier on your voice
      </span>
      {renderShiftAction ? renderShiftAction(semis) : null}
    </div>
  );
};

export default ComfortableHint;
