import classnames from "classnames";
import React from "react";
// tslint:disable-next-line:no-submodule-imports
import { BsPersonSquare } from "react-icons/bs";
// tslint:disable-next-line:no-submodule-imports
import { FaYoutube } from "react-icons/fa";
// tslint:disable-next-line:no-submodule-imports
import { MdMusicVideo } from "react-icons/md";
// tslint:disable-next-line:no-submodule-imports
import { SiNiconico } from "react-icons/si";
import { Link } from "react-router";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import damLogo from "url:../../images/dam-logo.png";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import joysoundLogo from "url:../../images/joysound-logo.svg";
import * as styles from "./SearchMethodGrid.module.scss";

const backgroundIcons = {
  song: <MdMusicVideo />,
  artist: <BsPersonSquare />,
  joysoundSong: <MdMusicVideo />,
  joysoundArtist: <BsPersonSquare />,
  youtube: <FaYoutube />,
  niconico: <SiNiconico />,
};

// JOYSOUND buttons wear their brand banner on the left edge, DAM on the
// right, so the two service rows mirror each other. YouTube/Niconico have
// no banner — their background icon is already the brand mark.
const brandBanners: {
  [method: string]: {
    service: "joysound" | "dam";
    side: "left" | "right";
    src: string;
    alt: string;
  };
} = {
  joysoundSong: {
    service: "joysound",
    side: "left",
    src: joysoundLogo,
    alt: "JOYSOUND",
  },
  joysoundArtist: {
    service: "joysound",
    side: "left",
    src: joysoundLogo,
    alt: "JOYSOUND",
  },
  song: { service: "dam", side: "right", src: damLogo, alt: "DAM" },
  artist: { service: "dam", side: "right", src: damLogo, alt: "DAM" },
};

interface Props {
  method:
    | "song"
    | "artist"
    | "joysoundSong"
    | "joysoundArtist"
    | "youtube"
    | "niconico";
  text: string;
}

const SearchMethodGridItem = ({ method, text }: Props) => {
  const banner = brandBanners[method];

  return (
    <div className={styles.gridItem}>
      <Link to={`/search/${method}`}>
        <div className={classnames(styles.button, styles[method])}>
          {banner && (
            <div
              className={classnames(
                styles.brandBanner,
                styles[banner.service],
                banner.side === "left"
                  ? styles.brandBannerLeft
                  : styles.brandBannerRight,
              )}
            >
              <img src={banner.src} alt={banner.alt} />
            </div>
          )}
          <span className={styles.icon}>{backgroundIcons[method]}</span>
          <span className={styles.text}>{text}</span>
        </div>
      </Link>
    </div>
  );
};

export default SearchMethodGridItem;
