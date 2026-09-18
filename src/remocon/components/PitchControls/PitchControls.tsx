import classnames from "classnames";
import React from "react";

import usePitchShiftSemis from "../../../common/hooks/usePitchShiftSemis";
import accessibleClick from "../accessibleClick";
import * as styles from "./PitchControls.module.scss";

const PitchControls = (props: { disabled: boolean }) => {
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();

  return (
    <div
      className={classnames(styles.controls, {
        [styles.disabled]: props.disabled,
      })}
    >
      <div
        className={styles.symbol}
        {...accessibleClick(() => setPitchShiftSemis(pitchShiftSemis - 1), {
          ariaLabel: "Pitch down",
          disabled: props.disabled,
        })}
      >
        ♭
      </div>
      <div className={styles.display}>{pitchShiftSemis}</div>
      <div
        className={styles.symbol}
        {...accessibleClick(() => setPitchShiftSemis(pitchShiftSemis + 1), {
          ariaLabel: "Pitch up",
          disabled: props.disabled,
        })}
      >
        ♯
      </div>
    </div>
  );
};

export default PitchControls;
