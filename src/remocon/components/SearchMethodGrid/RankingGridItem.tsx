import classnames from "classnames";
import React from "react";
import { Link } from "react-router";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import damLogo from "url:../../images/dam-logo.png";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import joysoundLogo from "url:../../images/joysound-logo.svg";
import * as styles from "./SearchMethodGrid.module.scss";

const serviceLogos = {
  joysound: { src: joysoundLogo, alt: "JOYSOUND" },
  dam: { src: damLogo, alt: "DAM" },
};

interface Props {
  service: "joysound" | "dam";
}

const RankingGridItem = ({ service }: Props) => (
  <div className={classnames(styles.gridItem, styles.fullWidthItem)}>
    <Link to={`/ranking/${service}`}>
      <div className={classnames(styles.rankingButton, styles[service])}>
        <img
          className={styles.rankingLogo}
          src={serviceLogos[service].src}
          alt={serviceLogos[service].alt}
        />
        <span className={styles.rankingText}>TOP 100</span>
      </div>
    </Link>
  </div>
);

export default RankingGridItem;
