import React, { useEffect, useState } from "react";

import useUserIdentity from "../../hooks/useUserIdentity";
import { JoysoundSongPageQuery$data } from "../../pages/__generated__/JoysoundSongPageQuery.graphql";
import ComfortableHint from "../ComfortableHint";
import JoysoundQueueButton from "./JoysoundQueueButton";
import * as styles from "./JoysoundQueueButtons.module.scss";

interface Props {
  song: JoysoundSongPageQuery$data["joysoundSongDetail"];
  youtubeVideoId: string | null;
  validatedYoutubeId: string | null;
  youtubeVideoSyncEnabled: boolean;
}

const JoysoundQueueButtons = ({
  song,
  youtubeVideoId,
  validatedYoutubeId,
  youtubeVideoSyncEnabled,
}: Props) => {
  const userIdentity = useUserIdentity();
  const [isDisabled, setIsDisabled] = useState(false);

  if (youtubeVideoId && !validatedYoutubeId) {
    return (
      <div className={styles.container}>
        <JoysoundQueueButton
          song={song}
          youtubeVideoId={youtubeVideoId}
          youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
          userIdentity={userIdentity}
          isRomaji={false}
          isDisabled={true}
          setDisabled={setIsDisabled}
        />

        <JoysoundQueueButton
          song={song}
          youtubeVideoId={youtubeVideoId}
          youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
          userIdentity={userIdentity}
          isRomaji={true}
          isDisabled={true}
          setDisabled={setIsDisabled}
        />
      </div>
    );
  } else {
    return (
      <div className={styles.container}>
        <JoysoundQueueButton
          song={song}
          youtubeVideoId={validatedYoutubeId}
          youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
          userIdentity={userIdentity}
          isRomaji={false}
          isDisabled={isDisabled}
          setDisabled={setIsDisabled}
        />

        <JoysoundQueueButton
          song={song}
          youtubeVideoId={validatedYoutubeId}
          youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
          userIdentity={userIdentity}
          isRomaji={true}
          isDisabled={isDisabled}
          setDisabled={setIsDisabled}
        />

        {/* Under the normal buttons, which are untouched. A suggestion adds a
            way to queue; it never replaces or disables the plain one. */}
        <ComfortableHint
          source="JOYSOUND"
          songId={song.id}
          allowFetch
          renderShiftAction={(semis) => (
            <JoysoundQueueButton
              song={song}
              youtubeVideoId={validatedYoutubeId}
              youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
              userIdentity={userIdentity}
              isRomaji={false}
              isDisabled={isDisabled}
              setDisabled={setIsDisabled}
              pitchShiftSemis={semis}
              label={`Queue at ${semis > 0 ? `+${semis}` : semis}`}
            />
          )}
        />
      </div>
    );
  }
};

export default JoysoundQueueButtons;
