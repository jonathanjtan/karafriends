import React, { useEffect, useState } from "react";
/* tslint:disable:no-submodule-imports */
import {
  FaCog,
  FaHistory,
  FaHome,
  FaMoon,
  FaSun,
  FaUserCircle,
} from "react-icons/fa";
/* tslint:enable:no-submodule-imports */
import { Link } from "react-router";
// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import icon from "url:../../images/icon.png";

import useUserIdentity from "../../hooks/useUserIdentity";
import AccountPicker from "../AccountPicker";
import Collapse from "../Collapse";
import RoomSettings from "../RoomSettings";
import * as styles from "./NavBar.module.scss";

const DARK_MODE_STORAGE_KEY = "darkMode";
const SHOW_SETTINGS_STORAGE_KEY = "showSettings";

const NavBar = () => {
  const { deviceId, personId, profilePictureUrl, profilePictureFrame } =
    useUserIdentity();
  // The handed-around-phone case: tap the avatar, become yourself, queue,
  // hand it back. Not persisted like the settings drawer. Switching is a
  // one-off action, not a mode you leave open.
  const [showAccounts, setShowAccounts] = useState<boolean>(false);
  const [darkMode, setDarkMode] = useState<boolean>(
    () => localStorage.getItem(DARK_MODE_STORAGE_KEY) === "true",
  );
  // Persisted so the settings panel stays collapsed across reloads. During
  // regular operation the phone should just show the queue, not the panel.
  const [showSettings, _setShowSettings] = useState<boolean>(
    () => localStorage.getItem(SHOW_SETTINGS_STORAGE_KEY) === "true",
  );

  const setShowSettings = (value: boolean) => {
    if (value) {
      localStorage.setItem(SHOW_SETTINGS_STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(SHOW_SETTINGS_STORAGE_KEY);
    }
    _setShowSettings(value);
  };

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
    <>
      <div className={styles.navBar}>
        <div className={styles.leftIcons}>
          <Link to="/">
            <FaHome />
          </Link>
          <button
            className={styles.iconButton}
            onClick={() => setShowAccounts(!showAccounts)}
            aria-label="Switch account"
          >
            {profilePictureUrl ? (
              <img
                className={`${styles.avatar}${
                  profilePictureFrame === "female"
                    ? ` ${styles.avatarFemale}`
                    : ""
                }`}
                src={profilePictureUrl}
                alt=""
              />
            ) : (
              <FaUserCircle />
            )}
          </button>
        </div>
        <img height={40} src={icon} alt="空" />
        <div className={styles.rightIcons}>
          <button
            className={styles.iconButton}
            onClick={() => setShowSettings(!showSettings)}
            aria-label="Toggle settings"
          >
            <FaCog />
          </button>
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
      <Collapse
        open={showAccounts}
        direction="down"
        className={styles.settingsDrawer}
      >
        <div className={styles.accountDrawer}>
          <AccountPicker
            deviceId={deviceId}
            heading="Switch account"
            currentPersonId={personId}
            onClaimed={() => setShowAccounts(false)}
          />
          <Link
            className={styles.editProfileLink}
            to="/profile"
            onClick={() => setShowAccounts(false)}
          >
            Edit profile
          </Link>
        </div>
      </Collapse>
      <Collapse
        open={showSettings}
        direction="down"
        className={styles.settingsDrawer}
      >
        <RoomSettings onNavigate={() => setShowSettings(false)} />
      </Collapse>
    </>
  );
};

export default NavBar;
