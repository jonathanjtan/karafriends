import React, { useState } from "react";

import useJoysoundBottomAnnotation from "../../../common/hooks/useJoysoundBottomAnnotation";
import useJoysoundTopAnnotation from "../../../common/hooks/useJoysoundTopAnnotation";
import { TelopAnnotation } from "../../../common/telopLayout";
import useUserIdentity from "../../hooks/useUserIdentity";
import { JoysoundSongPageQuery$data } from "../../pages/__generated__/JoysoundSongPageQuery.graphql";
import ComfortableHint from "../ComfortableHint";
import AnnotationPicker from "./AnnotationPicker";
import JoysoundQueueButton from "./JoysoundQueueButton";
import * as styles from "./JoysoundQueueButtons.module.scss";

interface Props {
  song: JoysoundSongPageQuery$data["joysoundSongDetail"];
  youtubeVideoId: string | null;
  validatedYoutubeId: string | null;
  youtubeVideoSyncEnabled: boolean;
}

// One queue button, with the reading guides this song should get above it.
// The pickers start on the room's own settings, so queueing without touching
// them expresses no opinion and the song plays whatever the room is on when
// it comes up. Picking something else sends it with the song: the room's
// settings are lent to it while it plays and taken back when it ends, and
// they can still be changed live from the settings meanwhile.
const JoysoundQueueButtons = ({
  song,
  youtubeVideoId,
  validatedYoutubeId,
  youtubeVideoSyncEnabled,
}: Props) => {
  const userIdentity = useUserIdentity();
  const [isDisabled, setIsDisabled] = useState(false);
  const { joysoundTopAnnotation } = useJoysoundTopAnnotation();
  const { joysoundBottomAnnotation } = useJoysoundBottomAnnotation();
  // Null until this singer picks a row for themselves, which is what tells
  // "I want the room's" apart from "I want what the room happens to be on".
  // Until then the pickers follow the room, so what they show is always what
  // queueing right now would give you.
  const [pickedTop, setPickedTop] = useState<TelopAnnotation | null>(null);
  const [pickedBottom, setPickedBottom] = useState<TelopAnnotation | null>(
    null,
  );

  const top = pickedTop ?? joysoundTopAnnotation;
  const bottom = pickedBottom ?? joysoundBottomAnnotation;
  const overridden =
    top !== joysoundTopAnnotation || bottom !== joysoundBottomAnnotation;

  // Sent as a pair or not at all: a song asking for one row and deferring on
  // the other would change appearance depending on when it came up.
  const annotations = overridden ? { top, bottom } : null;

  // A pasted video that hasn't been validated yet: wait for it rather than
  // queue the song without its video.
  const awaitingVideo = youtubeVideoId !== null && validatedYoutubeId === null;

  return (
    <div className={styles.container}>
      <div className={styles.pickers}>
        <AnnotationPicker
          label="Above lyrics"
          value={top}
          onChange={setPickedTop}
          disabled={awaitingVideo || isDisabled}
        />
        <AnnotationPicker
          label="Below lyrics"
          value={bottom}
          onChange={setPickedBottom}
          disabled={awaitingVideo || isDisabled}
        />
        {overridden ? (
          <p className={styles.pickerNote}>
            Just for this song. The room goes back to its own afterwards.
          </p>
        ) : null}
      </div>

      <JoysoundQueueButton
        song={song}
        youtubeVideoId={awaitingVideo ? youtubeVideoId : validatedYoutubeId}
        youtubeVideoSyncEnabled={youtubeVideoSyncEnabled}
        userIdentity={userIdentity}
        annotations={annotations}
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
              annotations={annotations}
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
