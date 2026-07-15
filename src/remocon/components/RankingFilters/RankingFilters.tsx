import classnames from "classnames";
import React from "react";

import * as styles from "./RankingFilters.module.scss";

// Mirrors the RankingCategory / RankingPeriod GraphQL enums.
export type RankingCategory =
  | "OVERALL"
  | "ANIME"
  | "VOCALOID"
  | "ENKA"
  | "WESTERN";
export type RankingPeriod = "WEEKLY" | "MONTHLY";

// The category row also offers "ARTIST", which isn't a genre — it swaps the
// list to the top-artist chart. Kept as a frontend-only selection since the
// artist ranking is a separate query with a different result type.
export type RankingSelection = RankingCategory | "ARTIST";

const SELECTIONS: ReadonlyArray<{ value: RankingSelection; label: string }> = [
  { value: "OVERALL", label: "Overall" },
  { value: "ANIME", label: "Anime" },
  { value: "VOCALOID", label: "Vocaloid" },
  { value: "ENKA", label: "Enka" },
  { value: "WESTERN", label: "Western" },
  { value: "ARTIST", label: "Artists" },
];

const PERIODS: ReadonlyArray<{ value: RankingPeriod; label: string }> = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
];

export function parseRankingSelection(
  raw: string | undefined,
): RankingSelection {
  const candidate = (raw || "").toUpperCase();
  return (
    SELECTIONS.find(({ value }) => value === candidate)?.value ?? "OVERALL"
  );
}

export function parseRankingPeriod(raw: string | undefined): RankingPeriod {
  const candidate = (raw || "").toUpperCase();
  return PERIODS.find(({ value }) => value === candidate)?.value ?? "WEEKLY";
}

interface Props {
  selection: RankingSelection;
  period: RankingPeriod;
  onChange: (selection: RankingSelection, period: RankingPeriod) => void;
}

const RankingFilters = ({ selection, period, onChange }: Props) => (
  <div className={styles.filters}>
    <div className={styles.row}>
      {SELECTIONS.map(({ value, label }) => (
        <button
          key={value}
          className={classnames(styles.chip, {
            [styles.selected]: selection === value,
          })}
          onClick={() => onChange(value, period)}
        >
          {label}
        </button>
      ))}
    </div>
    <div className={styles.row}>
      {PERIODS.map(({ value, label }) => (
        <button
          key={value}
          className={classnames(styles.chip, {
            [styles.selected]: period === value,
          })}
          onClick={() => onChange(selection, value)}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);

export default RankingFilters;
