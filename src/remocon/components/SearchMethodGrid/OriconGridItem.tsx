import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaChartBar } from "react-icons/fa";
import { Link } from "react-router";

import * as styles from "./SearchMethodGrid.module.scss";

// Sits with YouTube/Niconico rather than under a service banner: Oricon is a
// third-party chart, not a catalog you can search.
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
