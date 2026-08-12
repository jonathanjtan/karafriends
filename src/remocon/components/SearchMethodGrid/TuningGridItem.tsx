import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { MdGraphicEq } from "react-icons/md";
import { Link } from "react-router";

import * as styles from "./SearchMethodGrid.module.scss";

// The one tile here that isn't a way to find a song. It sits on the home grid
// because that is the screen everybody lands on, and it queues like a song, so
// there is nowhere else it would obviously go.
const TuningGridItem = () => (
  <div className={styles.gridItem}>
    <Link to="/tuning">
      <div className={classnames(styles.button, styles.tuning)}>
        <span className={styles.icon}>
          <MdGraphicEq />
        </span>
        <span className={styles.text}>Calibrate</span>
      </div>
    </Link>
  </div>
);

export default TuningGridItem;
