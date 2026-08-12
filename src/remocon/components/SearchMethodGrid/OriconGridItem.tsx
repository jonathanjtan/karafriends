import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaChartBar } from "react-icons/fa";
import { Link } from "react-router";

import * as styles from "./SearchMethodGrid.module.scss";

// Gets no brand banner: Oricon is a third-party chart, not a catalog you can
// search. It shares the bottom row with the warm-up for the same reason —
// neither is a way to search for a song.
const OriconGridItem = () => (
  <div className={styles.gridItem}>
    <Link to="/ranking/oricon">
      <div className={classnames(styles.button, styles.oricon)}>
        <span className={styles.icon}>
          <FaChartBar />
        </span>
        <span className={styles.text}>Oricon Top N</span>
      </div>
    </Link>
  </div>
);

export default OriconGridItem;
