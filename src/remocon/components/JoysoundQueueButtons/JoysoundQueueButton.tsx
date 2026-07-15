import React, { useEffect, useState } from "react";
import { fetchQuery, graphql, useMutation } from "react-relay";
import { Subscription } from "relay-runtime";
import { invariant } from "ts-invariant";

import environment from "../../../common/graphqlEnvironment";
import Button from "../Button";
import * as buttonStyles from "../Button/Button.module.scss";
import useProcessingLabel from "../Button/useProcessingLabel";
import { useToast } from "../Toast/ToastContext";

import { JoysoundSongPageQuery$data } from "../../pages/__generated__/JoysoundSongPageQuery.graphql";
import { JoysoundQueueButtonGetVideoDownloadProgressQuery } from "./__generated__/JoysoundQueueButtonGetVideoDownloadProgressQuery.graphql";
import {
  JoysoundQueueButtonMutation,
  JoysoundQueueButtonMutation$variables,
} from "./__generated__/JoysoundQueueButtonMutation.graphql";

const joysoundQueueButtonGetVideoDownloadProgressQuery = graphql`
  query JoysoundQueueButtonGetVideoDownloadProgressQuery(
    $videoDownloadType: Int!
    $songId: String!
    $suffix: String
  ) {
    videoDownloadProgress(
      videoDownloadType: $videoDownloadType
      songId: $songId
      suffix: $suffix
    ) {
      progress
    }
  }
`;

const joysoundQueueButtonMutation = graphql`
  mutation JoysoundQueueButtonMutation(
    $input: QueueJoysoundSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueJoysoundSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
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

interface Props {
  song: JoysoundSongPageQuery$data["joysoundSongDetail"];
  youtubeVideoId: string | null;
  youtubeVideoSyncEnabled: boolean;
  userIdentity: JoysoundQueueButtonMutation$variables["input"]["userIdentity"];
  isRomaji: boolean;
  isDisabled: boolean;
  setDisabled: (isDisabled: boolean) => void;
}

const JoysoundQueueButton = ({
  song,
  youtubeVideoId,
  youtubeVideoSyncEnabled,
  userIdentity,
  isRomaji,
  isDisabled,
  setDisabled,
}: Props) => {
  const defaultText = `Queue ${isRomaji ? "Romaji" : "Furigana"}`;

  const [text, setText] = useState(defaultText);
  const [commit] = useMutation<JoysoundQueueButtonMutation>(
    joysoundQueueButtonMutation,
  );
  const { showToast } = useToast();

  useEffect(() => {
    invariant(window);

    let intervalId: number | null = null;
    let timeoutId: number | null = null;
    let subscription: Subscription | null = null;

    if (text === "Finished Downloading" || text.includes("Error")) {
      timeoutId = window.setTimeout(() => {
        setText(defaultText);
        setDisabled(false);
      }, 2500);
    } else if (text !== defaultText && text !== "Queueing") {
      intervalId = window.setInterval(() => {
        subscription =
          fetchQuery<JoysoundQueueButtonGetVideoDownloadProgressQuery>(
            environment,
            joysoundQueueButtonGetVideoDownloadProgressQuery,
            {
              videoDownloadType: 0,
              songId: song.id,
              suffix: youtubeVideoId,
            },
          ).subscribe({
            next: (
              data: JoysoundQueueButtonGetVideoDownloadProgressQuery["response"],
            ) => {
              // The server keeps the download-queue entry alive until the
              // song actually lands in the queue, so -1 (no entry) means
              // done - and 100% means the raw download finished but the
              // intro-sync + compositing steps are still running.
              if (data.videoDownloadProgress.progress === -1.0) {
                setText("Finished Downloading");
              } else if (data.videoDownloadProgress.progress === 1.0) {
                setText("Processing video");
              } else {
                setText(
                  `Downloading -- ${(
                    data.videoDownloadProgress.progress * 100
                  ).toFixed(1)}%`,
                );
              }
            },
          });
      }, 1000);
    }

    return () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      if (subscription !== null) {
        subscription.unsubscribe();
      }
    };
  }, [text]);

  const { processing, displayText } = useProcessingLabel(text, defaultText);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setDisabled(true);
    setText("Queueing");

    console.log(`tryHeadOfQueue=${e.shiftKey}`);
    commit({
      variables: {
        input: {
          songId: song.id,
          name: song.name,
          playtime: null,
          artistName: song.artistName,
          userIdentity,
          isRomaji,
          youtubeVideoId,
          youtubeVideoSyncEnabled,
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: (response) => {
        // A resolver error nulls out the whole payload while onCompleted
        // still fires - don't destructure it blindly.
        const queueJoysoundSong = response?.queueJoysoundSong;

        switch (queueJoysoundSong?.__typename) {
          case "QueueSongInfo":
            setText("Downloading");
            showToast(`${song.name} added to queue!`);
            break;
          case "QueueSongError":
            setText(`Error: ${queueJoysoundSong.reason}`);
            break;
          default:
            // Without this the button would stay disabled on "Waiting for
            // server..." forever after a resolver error.
            setText("Error: queueing failed, try again");
            break;
        }
      },
      onError: (error) => {
        console.error(error);
        // The "Error" text auto-resets and re-enables the button after a
        // moment (see the effect above), turning a dropped request into a
        // visible, retryable failure instead of a stuck disabled button.
        setText("Error: queueing failed, try again");
      },
    });
  };

  return (
    <Button
      className={processing ? buttonStyles.processing : undefined}
      disabled={isDisabled}
      onClick={onClick}
    >
      {displayText}
    </Button>
  );
};

export default JoysoundQueueButton;
