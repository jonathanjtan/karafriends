import classnames from "classnames";
import React from "react";
import { graphql, useLazyLoadQuery } from "react-relay";

import { withLoader } from "../Loader";
import * as styles from "./RankingFilters.module.scss";
import { JoysoundMonthPickerQuery } from "./__generated__/JoysoundMonthPickerQuery.graphql";

const joysoundMonthPickerQuery = graphql`
  query JoysoundMonthPickerQuery {
    joysoundRankingMonths {
      value
      label
    }
  }
`;

interface Props {
  // Selected archive (YYYYMM), or null for the current/latest month.
  month: string | null;
  onChange: (month: string | null) => void;
}

const JoysoundMonthPicker = ({ month, onChange }: Props) => {
  const data = useLazyLoadQuery<JoysoundMonthPickerQuery>(
    joysoundMonthPickerQuery,
    {},
  );

  if (data.joysoundRankingMonths.length === 0) return null;

  return (
    <div className={styles.row}>
      {data.joysoundRankingMonths.map(({ value, label }) => (
        <button
          key={value ?? "current"}
          className={classnames(styles.chip, {
            [styles.selected]: (value ?? null) === month,
          })}
          onClick={() => onChange(value ?? null)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default withLoader(JoysoundMonthPicker);
