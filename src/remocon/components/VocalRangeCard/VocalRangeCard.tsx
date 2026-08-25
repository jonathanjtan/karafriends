import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";
import { Link } from "react-router";

import { midiToNoteName } from "../../../common/tuningExercise";
import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./VocalRangeCard.module.scss";
import { VocalRangeCardQuery } from "./__generated__/VocalRangeCardQuery.graphql";

const vocalRangeQuery = graphql`
  query VocalRangeCardQuery($nickname: String!, $personId: String) {
    vocalRange(nickname: $nickname, personId: $personId) {
      timestamp
      lowMidi
      highMidi
      comfortableLowMidi
      comfortableHighMidi
      hitFloor
      hitCeiling
    }
  }
`;

function whenLabel(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "measured today";
  if (days === 1) return "measured yesterday";
  if (days < 30) return `measured ${days} days ago`;
  return `measured ${new Date(timestamp).toLocaleDateString()}`;
}

// The stored result of the warm-up, on the profile page because it is a fact
// about you rather than about a song.
//
// Framed as a snapshot, never a verdict: it says "measured 3 days ago", it
// offers a re-run, and it makes no claim about what anybody should sing.
const VocalRangeCard = () => {
  const identity = useUserIdentity();
  const data = useLazyLoadQuery<VocalRangeCardQuery>(
    vocalRangeQuery,
    { nickname: identity.nickname, personId: identity.personId },
    { fetchPolicy: "store-and-network" },
  );

  const range = data.vocalRange;
  const lowMidi = range?.lowMidi;
  const highMidi = range?.highMidi;
  const comfortLow = range?.comfortableLowMidi;
  const comfortHigh = range?.comfortableHighMidi;

  if (
    range === null ||
    range === undefined ||
    lowMidi === null ||
    lowMidi === undefined ||
    highMidi === null ||
    highMidi === undefined
  ) {
    return (
      <div className={styles.card}>
        <div className={styles.empty}>
          Queue the <Link to="/tuning">vocal warm-up</Link> and the TV will show
          the range it hears. It's only used to point out songs that might sit
          nicely, or suggest a key that's easier on your voice.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.headline}>
        <span className={styles.note}>{midiToNoteName(lowMidi)}</span>
        <span className={styles.dash}>–</span>
        <span className={styles.note}>{midiToNoteName(highMidi)}</span>
      </div>
      {comfortLow !== null &&
      comfortLow !== undefined &&
      comfortHigh !== null &&
      comfortHigh !== undefined ? (
        <div className={styles.comfort}>
          most comfortable {midiToNoteName(comfortLow)} –{" "}
          {midiToNoteName(comfortHigh)}
        </div>
      ) : null}
      <div className={styles.meta}>
        {whenLabel(range.timestamp)} · <Link to="/tuning">measure again</Link>
      </div>
      {range.hitFloor || range.hitCeiling ? (
        <div className={styles.meta}>
          You went past the{" "}
          {range.hitFloor && range.hitCeiling
            ? "ends"
            : range.hitFloor
              ? "bottom"
              : "top"}{" "}
          of the warm-up, so there's more to find with a different starting
          note.
        </div>
      ) : null}
    </div>
  );
};

export default VocalRangeCard;
