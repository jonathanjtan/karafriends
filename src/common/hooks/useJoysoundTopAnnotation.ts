import { graphql } from "react-relay";

import {
  asTelopAnnotation,
  DEFAULT_TELOP_ANNOTATIONS,
  TelopAnnotation,
} from "../telopLayout";
import useSyncedServerValue from "./useSyncedServerValue";
import { useJoysoundTopAnnotationMutation } from "./__generated__/useJoysoundTopAnnotationMutation.graphql";
import { useJoysoundTopAnnotationQuery } from "./__generated__/useJoysoundTopAnnotationQuery.graphql";
import { useJoysoundTopAnnotationSubscription } from "./__generated__/useJoysoundTopAnnotationSubscription.graphql";

const joysoundTopAnnotationQuery = graphql`
  query useJoysoundTopAnnotationQuery {
    joysoundTopAnnotation
  }
`;

const joysoundTopAnnotationMutation = graphql`
  mutation useJoysoundTopAnnotationMutation($annotation: LyricsAnnotation!) {
    setJoysoundTopAnnotation(annotation: $annotation)
  }
`;

const joysoundTopAnnotationSubscription = graphql`
  subscription useJoysoundTopAnnotationSubscription {
    joysoundTopAnnotationChanged
  }
`;

// The reading guide drawn above JOYSOUND's main lyric text: JOYSOUND's own
// furigana, romaji, or nothing. Lives in the main process and stays
// live-synced across every renderer/remocon client, so the TV re-lays the
// playing song out the moment it changes. A discrete choice, so commits go
// out immediately (no debounce).
export default function useJoysoundTopAnnotation() {
  const { value: joysoundTopAnnotation, setValue: setJoysoundTopAnnotation } =
    useSyncedServerValue<
      useJoysoundTopAnnotationQuery,
      useJoysoundTopAnnotationMutation,
      useJoysoundTopAnnotationSubscription,
      TelopAnnotation
    >({
      query: joysoundTopAnnotationQuery,
      getQueryValue: (response) =>
        asTelopAnnotation(
          response.joysoundTopAnnotation,
          DEFAULT_TELOP_ANNOTATIONS.top,
        ),
      mutation: joysoundTopAnnotationMutation,
      makeMutationVariables: (annotation) => ({ annotation }),
      subscription: joysoundTopAnnotationSubscription,
      getSubscriptionValue: (response) =>
        asTelopAnnotation(
          response.joysoundTopAnnotationChanged,
          DEFAULT_TELOP_ANNOTATIONS.top,
        ),
      defaultValue: DEFAULT_TELOP_ANNOTATIONS.top,
    });

  return { joysoundTopAnnotation, setJoysoundTopAnnotation };
}
