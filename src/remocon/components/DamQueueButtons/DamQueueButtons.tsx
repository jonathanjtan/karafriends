import React, { useEffect, useState } from "react";

import useUserIdentity from "../../hooks/useUserIdentity";
import {
  SongPageQuery$data,
  VocalType,
} from "../../pages/__generated__/SongPageQuery.graphql";
import ComfortableHint from "../ComfortableHint";
import DamQueueButton from "./DamQueueButton";
import * as styles from "./DamQueueButtons.module.scss";

interface Props {
  song: SongPageQuery$data["songById"];
}

const DamQueueButtons = ({ song }: Props) => {
  const userIdentity = useUserIdentity();

  return (
    <div className={styles.container}>
      {song.vocalTypes.map((vocalType, i) => (
        <DamQueueButton
          key={vocalType}
          song={song}
          streamingUrlIndex={i}
          userIdentity={userIdentity}
        />
      ))}
      {/* Sits under the normal buttons, which are unchanged. A suggestion adds
          an extra way to queue; it never replaces or disables the plain one. */}
      <ComfortableHint
        source="DAM"
        songId={song.id}
        allowFetch
        renderShiftAction={(semis) => (
          <DamQueueButton
            song={song}
            streamingUrlIndex={0}
            userIdentity={userIdentity}
            pitchShiftSemis={semis}
            label={`Queue at ${semis > 0 ? `+${semis}` : semis}`}
          />
        )}
      />
    </div>
  );
};

export default DamQueueButtons;
