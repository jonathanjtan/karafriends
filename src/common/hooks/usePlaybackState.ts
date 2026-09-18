import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { usePlaybackStateMutation } from "./__generated__/usePlaybackStateMutation.graphql";
import { usePlaybackStateQuery } from "./__generated__/usePlaybackStateQuery.graphql";
import { usePlaybackStateSubscription } from "./__generated__/usePlaybackStateSubscription.graphql";

const playbackStateQuery = graphql`
  query usePlaybackStateQuery {
    playbackState
  }
`;

const playbackStateMutation = graphql`
  mutation usePlaybackStateMutation($playbackState: PlaybackState!) {
    setPlaybackState(playbackState: $playbackState)
  }
`;

const playbackStateSubscription = graphql`
  subscription usePlaybackStateSubscription {
    playbackStateChanged
  }
`;

type StateType = usePlaybackStateQuery["response"]["playbackState"];

export default function usePlaybackState() {
  const { value: playbackState, setValue: setPlaybackState } =
    useSyncedServerValue<
      usePlaybackStateQuery,
      usePlaybackStateMutation,
      usePlaybackStateSubscription,
      StateType
    >({
      query: playbackStateQuery,
      getQueryValue: (response) => response.playbackState,
      mutation: playbackStateMutation,
      makeMutationVariables: (nextPlaybackState) => ({
        playbackState: nextPlaybackState,
      }),
      subscription: playbackStateSubscription,
      getSubscriptionValue: (response) => response.playbackStateChanged,
      defaultValue: "WAITING",
    });

  return { playbackState, setPlaybackState };
}
