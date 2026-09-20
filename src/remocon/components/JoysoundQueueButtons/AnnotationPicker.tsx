import classnames from "classnames";
import React from "react";

import {
  TelopAnnotation,
  TELOP_ANNOTATION_CHOICES,
} from "../../../common/telopLayout";
import * as styles from "./JoysoundQueueButtons.module.scss";

// One row of the "how should this song's lyrics read" picker: the three
// guides as a segmented control, labelled and ordered the same way the
// settings screens label and order them (TELOP_ANNOTATION_CHOICES).
const AnnotationPicker = (props: {
  label: string;
  value: TelopAnnotation;
  onChange: (value: TelopAnnotation) => void;
  disabled?: boolean;
}) => (
  <div className={styles.pickerRow}>
    <span className={styles.pickerLabel}>{props.label}</span>
    <span className={styles.segmented} role="group" aria-label={props.label}>
      {TELOP_ANNOTATION_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className={classnames(styles.segment, {
            [styles.segmentActive]: props.value === choice.value,
          })}
          aria-pressed={props.value === choice.value}
          disabled={props.disabled}
          onClick={() => props.onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  </div>
);

export default AnnotationPicker;
