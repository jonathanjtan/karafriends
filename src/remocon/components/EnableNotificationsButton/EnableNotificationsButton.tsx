import React, { useState } from "react";
import Button from "../Button/Button";
import * as styles from "./EnableNotificationsButton.module.scss";

const EnableNotificationsButton = () => {
  const supported = "Notification" in window;
  // The initializer must not touch Notification when it doesn't exist; the
  // value is unused once the unsupported check below returns null.
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "denied",
  );

  if (!supported) return null;

  return permission === "default" ? (
    <div className={styles.enableNotificationsButtonContainer}>
      <Button
        onClick={async () =>
          setPermission(await Notification.requestPermission())
        }
      >
        Enable push notifications
      </Button>
    </div>
  ) : null;
};

export default EnableNotificationsButton;
