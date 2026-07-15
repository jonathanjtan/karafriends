import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaCrown } from "react-icons/fa";
import { Link } from "react-router";

import * as styles from "./SearchMethodGrid.module.scss";

interface Props {
  service: "joysound" | "dam";
}

const RankingGridItem = ({ service }: Props) => (
  <div className={styles.rankingItem}>
    <Link to={`/ranking/${service}`}>
      <div className={classnames(styles.button, styles[service])}>
        <span className={styles.icon}>
          <FaCrown />
        </span>
        <span className={styles.text}>Top 100</span>
      </div>
    </Link>
  </div>
);

export default RankingGridItem;
