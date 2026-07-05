import React, { useEffect, useState } from "react";
// tslint:disable-next-line:no-submodule-imports
import { FaHistory, FaHome, FaMoon, FaSun } from "react-icons/fa";
import { Link } from "react-router";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import icon from "url:../../images/icon.png";

import * as styles from "./NavBar.module.scss";

const DARK_MODE_STORAGE_KEY = "darkMode";

const NavBar = () => {
  const [darkMode, setDarkMode] = useState<boolean>(
    () => localStorage.getItem(DARK_MODE_STORAGE_KEY) === "true",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  const toggleDarkMode = () => {
    const next = !darkMode;
    if (next) {
      localStorage.setItem(DARK_MODE_STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(DARK_MODE_STORAGE_KEY);
    }
    setDarkMode(next);
  };

  return (
    <div className={styles.navBar}>
      <Link to="/">
        <FaHome />
      </Link>
      <img height={40} src={icon} alt="空" />
      <div className={styles.rightIcons}>
        <button
          className={styles.iconButton}
          onClick={toggleDarkMode}
          aria-label="Toggle dark mode"
        >
          {darkMode ? <FaSun /> : <FaMoon />}
        </button>
        <Link to="/history">
          <FaHistory />
        </Link>
      </div>
    </div>
  );
};

export default NavBar;
