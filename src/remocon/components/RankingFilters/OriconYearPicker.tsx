import classnames from "classnames";
import React from "react";

import { ORICON_CHART_YEARS } from "../../../common/oriconChart";
import * as styles from "./RankingFilters.module.scss";

// "current" is Oricon's live weekly chart; the rest are closed years from the
// bundled table. Oricon publishes no monthly karaoke chart, so the live end
// of the picker is a week, not a month.
export type OriconSelection = number | "current";

interface Props {
  selection: OriconSelection;
  onChange: (selection: OriconSelection) => void;
}

// The years come from a bundled table rather than a query, so unlike
// JoysoundMonthPicker this needs no loader or error boundary.
const OriconYearPicker = ({ selection, onChange }: Props) => (
  <div className={styles.row}>
    <button
      className={classnames(styles.chip, {
        [styles.selected]: selection === "current",
      })}
      onClick={() => onChange("current")}
    >
      This week
    </button>
    {ORICON_CHART_YEARS.map((value) => (
      <button
        key={value}
        className={classnames(styles.chip, {
          [styles.selected]: value === selection,
        })}
        onClick={() => onChange(value)}
      >
        {value}
      </button>
    ))}
  </div>
);

export default OriconYearPicker;
