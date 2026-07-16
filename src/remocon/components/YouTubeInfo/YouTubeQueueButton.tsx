import React, { useEffect, useState } from "react";
import { fetchQuery, graphql, useMutation } from "react-relay";
import { Subscription } from "relay-runtime";
import { invariant } from "ts-invariant";

import environment from "../../../common/graphqlEnvironment";
import Button from "../Button";
import * as buttonStyles from "../Button/Button.module.scss";
import useProcessingLabel from "../Button/useProcessingLabel";
import { useToast } from "../Toast/ToastContext";

import { YouTubeInfoVideoInfoQuery$data } from "./__generated__/YouTubeInfoVideoInfoQuery.graphql";
import { YouTubeQueueButtonGetVideoDownloadProgressQuery } from "./__generated__/YouTubeQueueButtonGetVideoDownloadProgressQuery.graphql";
import {
  YouTubeQueueButtonMutation,
  YouTubeQueueButtonMutation$variables,
} from "./__generated__/YouTubeQueueButtonMutation.graphql";

const youTubeQueueButtonGetVideoDownloadProgressQuery = graphql`
  query YouTubeQueueButtonGetVideoDownloadProgressQuery(
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

const youTubeQueueButtonMutation = graphql`
  mutation YouTubeQueueButtonMutation(
    $input: QueueYoutubeSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueYoutubeSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
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
  videoId: string;
  videoInfo: YouTubeInfoVideoInfoQuery$data["youtubeVideoInfo"];
  adhocSongLyrics: string | null;
  selectedCaption: string | null;
  userIdentity: YouTubeQueueButtonMutation$variables["input"]["userIdentity"];
}

const YouTubeQueueButton = ({
  videoId,
  videoInfo,
  adhocSongLyrics,
  selectedCaption,
  userIdentity,
}: Props) => {
  if (videoInfo.__typename !== "YoutubeVideoInfo") return null;

  const defaultText = "Queue video";
  const [text, setText] = useState(defaultText);
  const [commit] = useMutation<YouTubeQueueButtonMutation>(
    youTubeQueueButtonMutation,
  );
  const { showToast } = useToast();

  useEffect(() => {
    invariant(window);

    let intervalId: number | null = null;
    let timeoutId: number | null = null;
    let subscription: Subscription | null = null;

    if (text === "Finished Downloading" || text.includes("Error")) {
      if (text === "Finished Downloading") {
        showToast(`${videoInfo.title} added to queue!`);
      }
      timeoutId = window.setTimeout(() => setText(defaultText), 2500);
    } else if (text !== defaultText && text !== "Queueing") {
      intervalId = window.setInterval(() => {
        subscription =
          fetchQuery<YouTubeQueueButtonGetVideoDownloadProgressQuery>(
            environment,
            youTubeQueueButtonGetVideoDownloadProgressQuery,
            {
              videoDownloadType: 1,
              songId: videoId,
              suffix: null,
            },
          ).subscribe({
            next: (
              data: YouTubeQueueButtonGetVideoDownloadProgressQuery["response"],
            ) => {
              if (
                data.videoDownloadProgress.progress === 1.0 ||
                (text !== "Downloading" &&
                  data.videoDownloadProgress.progress === -1.0)
              ) {
                setText("Finished Downloading");
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

      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, [text]);

  const { processing, displayText } = useProcessingLabel(text, defaultText);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setText("Queueing");

    console.log(`tryHeadOfQueue=${e.shiftKey}`);
    commit({
      variables: {
        input: {
          songId: videoId,
          name: videoInfo.title,
          artistName: videoInfo.author,
          playtime: videoInfo.lengthSeconds,
          userIdentity,
          adhocSongLyrics,
          captionCode: selectedCaption || null,
          gainValue: videoInfo.gainValue,
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: (response) => {
        // A resolver error nulls out the whole payload while onCompleted
        // still fires - don't destructure it blindly.
        const queueYoutubeSong = response?.queueYoutubeSong;

        switch (queueYoutubeSong?.__typename) {
          case "QueueSongInfo":
            setText("Downloading");
            break;
          case "QueueSongError":
            setText(`Error: ${queueYoutubeSong.reason}`);
            break;
          default:
            setText("Error: queueing failed, try again");
            break;
        }
      },
      onError: (error) => {
        console.error(error);
        // The "Error" text auto-resets and re-enables the button after a
        // moment (see the effect above) - without it a dropped request
        // leaves the button stuck disabled on "Waiting for server...".
        setText("Error: queueing failed, try again");
      },
    });
  };

  return (
    <Button
      className={processing ? buttonStyles.processing : undefined}
      disabled={text !== defaultText}
      onClick={onClick}
    >
      {displayText}
    </Button>
  );
};

export default YouTubeQueueButton;
