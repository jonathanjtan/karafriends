import React, { useState } from "react";

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

// One button. Whether the lyrics get furigana, romaji or both is a room
// setting (the Lyrics section of the settings), switchable while the song
// plays, rather than something decided per queued song.
const JoysoundQueueButtons = ({
  song,
  youtubeVideoId,
  validatedYoutubeId,
  youtubeVideoSyncEnabled,
}: Props) => {
  const userIdentity = useUserIdentity();
  const [isDisabled, setIsDisabled] = useState(false);

  // A pasted video that hasn't been validated yet: wait for it rather than
  // queue the song without its video.
  const awaitingVideo = youtubeVideoId !== null && validatedYoutubeId === null;

  return (
    <div className={styles.container}>
      <JoysoundQueueButton
        song={song}
        youtubeVideoId={awaitingVideo ? youtubeVideoId : validatedYoutubeId}
        youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
        userIdentity={userIdentity}
        isDisabled={awaitingVideo || isDisabled}
        setDisabled={setIsDisabled}
      />

      {awaitingVideo ? null : (
        /* Under the normal button, which is untouched. A suggestion adds a
           way to queue; it never replaces or disables the plain one. */
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
              isDisabled={isDisabled}
              setDisabled={setIsDisabled}
              pitchShiftSemis={semis}
              label={`Queue at ${semis > 0 ? `+${semis}` : semis}`}
            />
          )}
        />
      )}
    </div>
  );
};

export default JoysoundQueueButtons;
