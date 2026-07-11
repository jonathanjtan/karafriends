import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
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
  const [playbackState, setLocalPlaybackState] = useState<StateType>("WAITING");
  const [commit] = useMutation<usePlaybackStateMutation>(playbackStateMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<usePlaybackStateQuery>(
        environment,
        playbackStateQuery,
        {},
      ).subscribe({
        next: (response: usePlaybackStateQuery["response"]) =>
          setLocalPlaybackState(response.playbackState),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<usePlaybackStateQuery>(
      environment,
      playbackStateQuery,
      {},
      (response) => setLocalPlaybackState(response.playbackState),
    );

    const subscription = requestSubscription<usePlaybackStateSubscription>(
      environment,
      {
        subscription: playbackStateSubscription,
        variables: {},
        onNext: (response) => {
          if (response) setLocalPlaybackState(response.playbackStateChanged);
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  const setPlaybackState = (nextPlaybackState: StateType) => {
    setLocalPlaybackState(nextPlaybackState);
    commit({ variables: { playbackState: nextPlaybackState } });
  };

  return { playbackState, setPlaybackState };
}
