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

const CATEGORIES: ReadonlyArray<{ value: RankingCategory; label: string }> = [
  { value: "OVERALL", label: "Overall" },
  { value: "ANIME", label: "Anime" },
  { value: "VOCALOID", label: "Vocaloid" },
  { value: "ENKA", label: "Enka" },
  { value: "WESTERN", label: "Western" },
];

const PERIODS: ReadonlyArray<{ value: RankingPeriod; label: string }> = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
];

export function parseRankingCategory(raw: string | undefined): RankingCategory {
  const candidate = (raw || "").toUpperCase();
  return (
    CATEGORIES.find(({ value }) => value === candidate)?.value ?? "OVERALL"
  );
}

export function parseRankingPeriod(raw: string | undefined): RankingPeriod {
  const candidate = (raw || "").toUpperCase();
  return PERIODS.find(({ value }) => value === candidate)?.value ?? "WEEKLY";
}

interface Props {
  category: RankingCategory;
  period: RankingPeriod;
  onChange: (category: RankingCategory, period: RankingPeriod) => void;
}

const RankingFilters = ({ category, period, onChange }: Props) => (
  <div className={styles.filters}>
    <div className={styles.row}>
      {CATEGORIES.map(({ value, label }) => (
        <button
          key={value}
          className={classnames(styles.chip, {
            [styles.selected]: category === value,
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
          onClick={() => onChange(category, value)}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
);

export default RankingFilters;
