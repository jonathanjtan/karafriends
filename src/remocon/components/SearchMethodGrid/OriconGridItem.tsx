import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaCrown } from "react-icons/fa";
import { Link } from "react-router";

import * as styles from "./SearchMethodGrid.module.scss";

// Gets no brand banner: Oricon is a third-party chart, not a catalog you can
// search. It shares the bottom row with the warm-up for the same reason —
// neither is a way to search for a song. It does take the charts' crown and
// their metal, in bronze, because it is the same kind of destination as the
// two Top 100s above it.
const OriconGridItem = () => (
  <div className={styles.gridItem}>
    <Link to="/ranking/oricon">
      <div className={classnames(styles.button, styles.oricon)}>
        <span className={styles.icon}>
          <FaCrown />
        </span>
        <span className={styles.text}>Oricon Top N</span>
      </div>
    </Link>
  </div>
);

export default OriconGridItem;
