import classnames from "classnames";
import React from "react";

import useBgmVolume from "../../../common/hooks/useBgmVolume";
import useConfig from "../../hooks/useConfig";
import useUserIdentity from "../../hooks/useUserIdentity";
import * as styles from "./VolumeControls.module.scss";

const VolumeControls = () => {
  const { bgmVolume, setBgmVolume } = useBgmVolume();

  const config = useConfig();
  const identity = useUserIdentity();

  // Global volumes affect the whole room; in supervised mode only admins get
  // to touch them (same policy as playback controls).
  const disabled =
    config !== undefined &&
    config.supervisedMode === true &&
    !config.adminNicks.includes(identity.nickname) &&
    !config.adminDeviceIds.includes(identity.deviceId);

  return (
    <div className={classnames(styles.panel, { [styles.disabled]: disabled })}>
      <div>
        <div className={styles.labelRow}>
          <span>Background Music</span>
          <span>{Math.round(bgmVolume * 100)}%</span>
        </div>
        <input
          className={styles.slider}
          type="range"
          min="0"
          max="100"
          value={Math.round(bgmVolume * 100)}
          onChange={(e) => setBgmVolume(Number(e.target.value) / 100)}
        />
      </div>
    </div>
  );
};

export default VolumeControls;
