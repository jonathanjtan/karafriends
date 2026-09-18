import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
  const {
    value: joysoundRomajiWordSegmentation,
    setValue: setJoysoundRomajiWordSegmentation,
  } = useSyncedServerValue<
    useJoysoundRomajiWordSegmentationQuery,
    useJoysoundRomajiWordSegmentationMutation,
    useJoysoundRomajiWordSegmentationSubscription,
    boolean
  >({
    query: joysoundRomajiWordSegmentationQuery,
    getQueryValue: (response) => response.joysoundRomajiWordSegmentation,
    mutation: joysoundRomajiWordSegmentationMutation,
    makeMutationVariables: (enabled) => ({ enabled }),
    subscription: joysoundRomajiWordSegmentationSubscription,
    getSubscriptionValue: (response) =>
      response.joysoundRomajiWordSegmentationChanged,
    defaultValue: false,
  });

  return {
    joysoundRomajiWordSegmentation,
    setJoysoundRomajiWordSegmentation,
  };
}
