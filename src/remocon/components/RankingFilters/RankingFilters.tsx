import classnames from "classnames";
import React from "react";

import * as styles from "./RankingFilters.module.scss";

// Mirrors the RankingCategory / RankingPeriod GraphQL enums. VTUBER and DUET
// are DAM-only (see rankings.ts) — callers pass `categories` to restrict
// which chips are offered on a given page.
export type RankingCategory =
  | "OVERALL"
  | "ANIME"
  | "VOCALOID"
  | "ENKA"
  | "WESTERN"
  | "VTUBER"
  | "DUET";
export type RankingPeriod = "WEEKLY" | "MONTHLY";

// The category row also offers "ARTIST", which isn't a genre — it swaps the
// list to the top-artist chart. Kept as a frontend-only selection since the
// artist ranking is a separate query with a different result type.
export type RankingSelection = RankingCategory | "ARTIST";

const ALL_SELECTIONS: ReadonlyArray<{
  value: RankingSelection;
  label: string;
}> = [
  { value: "OVERALL", label: "Overall" },
  { value: "ANIME", label: "Anime" },
  { value: "VOCALOID", label: "Vocaloid" },
  { value: "ENKA", label: "Enka" },
  { value: "WESTERN", label: "Western" },
  { value: "VTUBER", label: "VTuber" },
  { value: "DUET", label: "Duet" },
  { value: "ARTIST", label: "Artists" },
];

// Default (JOYSOUND-safe) selection set — excludes the DAM-only categories.
const DEFAULT_SELECTIONS: ReadonlyArray<RankingSelection> = [
  "OVERALL",
  "ANIME",
  "VOCALOID",
  "ENKA",
  "WESTERN",
  "ARTIST",
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
    ALL_SELECTIONS.find(({ value }) => value === candidate)?.value ?? "OVERALL"
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
  // Which chips to offer, in order. Defaults to the categories both services
  // publish; pass the DAM-only categories in too on a DAM-specific page.
  categories?: ReadonlyArray<RankingSelection>;
}

const RankingFilters = ({
  selection,
  period,
  onChange,
  categories = DEFAULT_SELECTIONS,
}: Props) => {
  const selections = categories
    .map((value) => ALL_SELECTIONS.find((s) => s.value === value))
    .filter(
      (s): s is { value: RankingSelection; label: string } => s !== undefined,
    );

  return (
    <div className={styles.filters}>
      <div className={styles.row}>
        {selections.map(({ value, label }) => (
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
};

export default RankingFilters;
