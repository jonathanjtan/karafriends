import formatDuration from "format-duration";
import React, { useEffect, useState } from "react";
import { graphql, useMutation } from "react-relay";

import { SongPageQuery$data } from "../../pages/__generated__/SongPageQuery.graphql";
import Button from "../Button";
import { useToast } from "../Toast/ToastContext";
import {
  DamQueueButtonMutation,
  DamQueueButtonMutation$variables,
} from "./__generated__/DamQueueButtonMutation.graphql";

const damQueueButtonMutation = graphql`
  mutation DamQueueButtonMutation(
    $input: QueueDamSongInput!
    $tryHeadOfQueue: Boolean!
  ) {
    queueDamSong(input: $input, tryHeadOfQueue: $tryHeadOfQueue) {
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

function getDefaultText(vocalType: string) {
  let defaultText = "Queue song - guide vocal (unknown type)";
  switch (vocalType) {
    case "NORMAL":
      defaultText = "Queue song";
      break;
    case "GUIDE_MALE":
      defaultText = "Queue song - guide vocal (male)";
      break;
    case "GUIDE_FEMALE":
      defaultText = "Queue song - guide vocal (female)";
      break;
  }
  return defaultText;
}

interface Props {
  song: SongPageQuery$data["songById"];
  streamingUrlIndex: number;
  userIdentity: DamQueueButtonMutation$variables["input"]["userIdentity"];
}

const DamQueueButton = ({ song, streamingUrlIndex, userIdentity }: Props) => {
  const defaultText = getDefaultText(song.vocalTypes[streamingUrlIndex]);
  const [text, setText] = useState(defaultText);
  const [commit] = useMutation<DamQueueButtonMutation>(damQueueButtonMutation);
  const { showToast } = useToast();

  useEffect(() => {
    const timeout = setTimeout(() => setText(defaultText), 2500);
    return () => clearTimeout(timeout);
  });

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    console.log(`tryHeadOfQueue=${e.shiftKey}`);
    commit({
      variables: {
        input: {
          songId: song.id,
          name: song.name,
          artistName: song.artistName,
          playtime: song.playtime,
          streamingUrlIdx: streamingUrlIndex,
          userIdentity,
        },
        tryHeadOfQueue: e.shiftKey,
      },
      onCompleted: (response) => {
        // A resolver error nulls out the whole payload while onCompleted
        // still fires - don't destructure it blindly.
        const queueDamSong = response?.queueDamSong;

        switch (queueDamSong?.__typename) {
          case "QueueSongInfo":
            setText(
              `Estimated wait: T-${formatDuration(queueDamSong.eta * 1000)}`,
            );
            showToast(`${song.name} added to queue!`);
            break;
          case "QueueSongError":
            setText(`Error: ${queueDamSong.reason}`);
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
    <Button disabled={text !== defaultText} onClick={onClick}>
      {text}
    </Button>
  );
};

export default DamQueueButton;
