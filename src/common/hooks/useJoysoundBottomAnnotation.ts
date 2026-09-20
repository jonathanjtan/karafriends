import { graphql } from "react-relay";

import {
  asTelopAnnotation,
  DEFAULT_TELOP_ANNOTATIONS,
  TelopAnnotation,
} from "../telopLayout";
import useSyncedServerValue from "./useSyncedServerValue";
import { useJoysoundBottomAnnotationMutation } from "./__generated__/useJoysoundBottomAnnotationMutation.graphql";
import { useJoysoundBottomAnnotationQuery } from "./__generated__/useJoysoundBottomAnnotationQuery.graphql";
import { useJoysoundBottomAnnotationSubscription } from "./__generated__/useJoysoundBottomAnnotationSubscription.graphql";

const joysoundBottomAnnotationQuery = graphql`
  query useJoysoundBottomAnnotationQuery {
    joysoundBottomAnnotation
  }
`;

const joysoundBottomAnnotationMutation = graphql`
  mutation useJoysoundBottomAnnotationMutation($annotation: LyricsAnnotation!) {
    setJoysoundBottomAnnotation(annotation: $annotation)
  }
`;

const joysoundBottomAnnotationSubscription = graphql`
  subscription useJoysoundBottomAnnotationSubscription {
    joysoundBottomAnnotationChanged
  }
`;

// The reading guide drawn below JOYSOUND's main lyric text. The counterpart
// of useJoysoundTopAnnotation; see there.
export default function useJoysoundBottomAnnotation() {
  const {
    value: joysoundBottomAnnotation,
    setValue: setJoysoundBottomAnnotation,
  } = useSyncedServerValue<
    useJoysoundBottomAnnotationQuery,
    useJoysoundBottomAnnotationMutation,
    useJoysoundBottomAnnotationSubscription,
    TelopAnnotation
  >({
    query: joysoundBottomAnnotationQuery,
    getQueryValue: (response) =>
      asTelopAnnotation(
        response.joysoundBottomAnnotation,
        DEFAULT_TELOP_ANNOTATIONS.bottom,
      ),
    mutation: joysoundBottomAnnotationMutation,
    makeMutationVariables: (annotation) => ({ annotation }),
    subscription: joysoundBottomAnnotationSubscription,
    getSubscriptionValue: (response) =>
      asTelopAnnotation(
        response.joysoundBottomAnnotationChanged,
        DEFAULT_TELOP_ANNOTATIONS.bottom,
      ),
    defaultValue: DEFAULT_TELOP_ANNOTATIONS.bottom,
  });

  return { joysoundBottomAnnotation, setJoysoundBottomAnnotation };
}
