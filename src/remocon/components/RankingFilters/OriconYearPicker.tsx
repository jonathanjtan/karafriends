import classnames from "classnames";
import React from "react";

import { ORICON_CHART_YEARS } from "../../../common/oriconChart";
import * as styles from "./RankingFilters.module.scss";

interface Props {
  year: number;
  onChange: (year: number) => void;
}

// The Oricon years come from a bundled table rather than a query, so unlike
// JoysoundMonthPicker this needs no loader or error boundary.
const OriconYearPicker = ({ year, onChange }: Props) => (
  <div className={styles.row}>
    {ORICON_CHART_YEARS.map((value) => (
      <button
        key={value}
        className={classnames(styles.chip, {
          [styles.selected]: value === year,
        })}
        onClick={() => onChange(value)}
      >
        {value}
      </button>
    ))}
  </div>
);

export default OriconYearPicker;
