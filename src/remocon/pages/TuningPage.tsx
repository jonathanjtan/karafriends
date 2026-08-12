import React, { useState } from "react";
import { graphql, useMutation } from "react-relay";

import {
  DEFAULT_PRESET_ID,
  midiToNoteName,
  TUNING_PRESETS,
} from "../../common/tuningExercise";
import Button from "../components/Button";
import * as buttonStyles from "../components/Button/Button.module.scss";
import useProcessingLabel from "../components/Button/useProcessingLabel";
import { useToast } from "../components/Toast/ToastContext";
import useUserIdentity from "../hooks/useUserIdentity";
import * as styles from "./TuningPage.module.scss";
import { TuningPageQueueMutation } from "./__generated__/TuningPageQueueMutation.graphql";

const queueTuningTestMutation = graphql`
  mutation TuningPageQueueMutation(
    $input: QueueTuningTestInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueTuningTest(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
      ... on QueueSongInfo {
        __typename
        eta
      }
      ... on QueueSongError {
        __typename
        reason
      }
    }
  }
`;

const DEFAULT_TEXT = "Queue the warm-up";

const TuningPage = () => {
  const userIdentity = useUserIdentity();
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [commit] = useMutation<TuningPageQueueMutation>(
    queueTuningTestMutation,
  );
  const { showToast } = useToast();
  const { processing, displayText } = useProcessingLabel(text, DEFAULT_TEXT);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setText("Queueing");
    commit({
      variables: {
        input: { userIdentity, presetId },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: (response) => {
        const result = response?.queueTuningTest;
        switch (result?.__typename) {
          case "QueueSongInfo":
            setText(DEFAULT_TEXT);
            showToast("Warm-up added to the queue!");
            break;
          case "QueueSongError":
            setText(`Error: ${result.reason}`);
            break;
          default:
            setText("Error: queueing failed, try again");
            break;
        }
      },
      onError: (error) => {
        console.error(error);
        setText("Error: queueing failed, try again");
      },
    });
  };

  return (
    <div className={styles.page}>
      <h2>Calibrate</h2>
      <p className={styles.blurb}>
        A minute of held notes that walks down and then up from the middle. Sing
        along with each tone for as long as you can, and skip any that don't
        feel good.
      </p>
      <p className={styles.blurb}>
        If mics are configured, your range will be inferred from the notes and
        used for songs/key change recommendations!
      </p>

      <h3 className={styles.sectionTitle}>Where should it start?</h3>
      <div className={styles.presets}>
        {TUNING_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={
              preset.id === presetId
                ? `${styles.preset} ${styles.presetActive}`
                : styles.preset
            }
            onClick={() => setPresetId(preset.id)}
          >
            <span className={styles.presetLabel}>{preset.label}</span>
            <span className={styles.presetNote}>
              starts at {midiToNoteName(preset.centreMidi)}
            </span>
          </button>
        ))}
      </div>
      <p className={styles.hint}>
        Pick whichever is closest to start: the note range will expand as
        needed.
      </p>

      <Button
        full
        className={processing ? buttonStyles.processing : undefined}
        disabled={text !== DEFAULT_TEXT}
        onClick={onClick}
      >
        {displayText}
      </Button>
    </div>
  );
};

export default TuningPage;
