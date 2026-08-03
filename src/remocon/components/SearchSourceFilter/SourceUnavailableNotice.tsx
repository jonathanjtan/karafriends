import React from "react";

import * as styles from "./SearchSourceFilter.module.scss";

interface Props {
  // SongSource values that didn't answer the search.
  sources: ReadonlyArray<string>;
  onRetry: () => void;
  isRetrying: boolean;
}

// A merged search returns whatever the reachable catalogs found rather than
// failing, so this is what says the list is short on purpose. DAM goes dark
// routinely (a blocked exit IP), and a room that can't tell "no results" from
// "half the catalogs are missing" gives up on a song that is actually there.
const SourceUnavailableNotice = ({ sources, onRetry, isRetrying }: Props) => {
  if (sources.length === 0) return null;

  return (
    <div className={styles.notice}>
      <span>
        {sources.join(" and ")} didn&apos;t answer.{" "}
        {sources.length === 1 ? "Those results are" : "Their results are"}{" "}
        missing from this list.
      </span>
      <button
        type="button"
        className={styles.retry}
        onClick={onRetry}
        disabled={isRetrying}
      >
        {isRetrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
};

export default SourceUnavailableNotice;
