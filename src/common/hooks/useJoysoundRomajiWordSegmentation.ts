import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useJoysoundRomajiWordSegmentationMutation } from "./__generated__/useJoysoundRomajiWordSegmentationMutation.graphql";
import { useJoysoundRomajiWordSegmentationQuery } from "./__generated__/useJoysoundRomajiWordSegmentationQuery.graphql";
import { useJoysoundRomajiWordSegmentationSubscription } from "./__generated__/useJoysoundRomajiWordSegmentationSubscription.graphql";

const joysoundRomajiWordSegmentationQuery = graphql`
  query useJoysoundRomajiWordSegmentationQuery {
    joysoundRomajiWordSegmentation
  }
`;

const joysoundRomajiWordSegmentationMutation = graphql`
  mutation useJoysoundRomajiWordSegmentationMutation($enabled: Boolean!) {
    setJoysoundRomajiWordSegmentation(enabled: $enabled)
  }
`;

const joysoundRomajiWordSegmentationSubscription = graphql`
  subscription useJoysoundRomajiWordSegmentationSubscription {
    joysoundRomajiWordSegmentationChanged
  }
`;

// Whether JOYSOUND romaji lyrics are segmented at kuromoji word boundaries
// (e.g. あるもの -> "aru mono") instead of only at script-class boundaries
// (e.g. "arumono"). Lives in the main process and stays live-synced across
// every renderer/remocon client so it can be A/B toggled on the fly. A
// discrete toggle, so commits go out immediately (no debounce).
export default function useJoysoundRomajiWordSegmentation() {
  const [
    joysoundRomajiWordSegmentation,
    setLocalJoysoundRomajiWordSegmentation,
  ] = useState(false);
  const [commit] = useMutation<useJoysoundRomajiWordSegmentationMutation>(
    joysoundRomajiWordSegmentationMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useJoysoundRomajiWordSegmentationQuery>(
        environment,
        joysoundRomajiWordSegmentationQuery,
        {},
      ).subscribe({
        next: (response: useJoysoundRomajiWordSegmentationQuery["response"]) =>
          setLocalJoysoundRomajiWordSegmentation(
            response.joysoundRomajiWordSegmentation,
          ),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery =
      fetchQueryWithRetry<useJoysoundRomajiWordSegmentationQuery>(
        environment,
        joysoundRomajiWordSegmentationQuery,
        {},
        (response) =>
          setLocalJoysoundRomajiWordSegmentation(
            response.joysoundRomajiWordSegmentation,
          ),
      );

    const subscription =
      requestSubscription<useJoysoundRomajiWordSegmentationSubscription>(
        environment,
        {
          subscription: joysoundRomajiWordSegmentationSubscription,
          variables: {},
          onNext: (response) => {
            if (response)
              setLocalJoysoundRomajiWordSegmentation(
                response.joysoundRomajiWordSegmentationChanged,
              );
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

  const setJoysoundRomajiWordSegmentation = (value: boolean) => {
    setLocalJoysoundRomajiWordSegmentation(value);
    commit({ variables: { enabled: value } });
  };

  return {
    joysoundRomajiWordSegmentation,
    setJoysoundRomajiWordSegmentation,
  };
}
