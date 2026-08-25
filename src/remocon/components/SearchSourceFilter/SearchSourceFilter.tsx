import classnames from "classnames";
import React from "react";

import * as styles from "./SearchSourceFilter.module.scss";

// Mirrors the SongSource GraphQL enum. `null` is the unfiltered "All" chip.
export type SearchSource = "DAM" | "JOYSOUND";

const SOURCES: ReadonlyArray<{ value: SearchSource; label: string }> = [
  { value: "JOYSOUND", label: "JOYSOUND" },
  { value: "DAM", label: "DAM" },
];

export function parseSearchSource(
  raw: string | undefined,
): SearchSource | null {
  const candidate = (raw || "").toUpperCase();
  return SOURCES.find(({ value }) => value === candidate)?.value ?? null;
}

interface Props {
  selected: SearchSource | null;
  onSelect: (source: SearchSource | null) => void;
  // Rows loaded so far, per source. These count what's on screen rather than
  // what the catalogs hold. The chips filter the loaded list rather than
  // re-running the search, so they climb as "More" pulls further pages.
  counts: Record<SearchSource, number>;
  // Catalogs that didn't answer. Their chip goes quiet and unselectable
  // rather than disappearing, so a filtered-to-nothing list is explained.
  unavailable: ReadonlyArray<string>;
}

const SearchSourceFilter = ({
  selected,
  onSelect,
  counts,
  unavailable,
}: Props) => (
  <div className={styles.filters}>
    <button
      type="button"
      className={classnames(styles.chip, { [styles.selected]: !selected })}
      onClick={() => onSelect(null)}
    >
      All <span className={styles.count}>{counts.DAM + counts.JOYSOUND}</span>
    </button>
    {SOURCES.map(({ value, label }) => {
      const isDown = unavailable.includes(value);
      return (
        <button
          key={value}
          type="button"
          disabled={isDown}
          className={classnames(styles.chip, styles[value.toLowerCase()], {
            [styles.selected]: selected === value,
            [styles.unavailable]: isDown,
          })}
          onClick={() => onSelect(selected === value ? null : value)}
        >
          <span className={styles.dot} />
          {label}
          {isDown ? null : (
            <span className={styles.count}>{counts[value]}</span>
          )}
        </button>
      );
    })}
  </div>
);

export default SearchSourceFilter;
