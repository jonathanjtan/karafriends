import { graphql } from "react-relay";

import useSyncedServerFloat from "./useSyncedServerFloat";
import { usePianoRollOpacityMutation } from "./__generated__/usePianoRollOpacityMutation.graphql";
import { usePianoRollOpacityQuery } from "./__generated__/usePianoRollOpacityQuery.graphql";
import { usePianoRollOpacitySubscription } from "./__generated__/usePianoRollOpacitySubscription.graphql";

const pianoRollOpacityQuery = graphql`
  query usePianoRollOpacityQuery {
    pianoRollOpacity
  }
`;

const pianoRollOpacityMutation = graphql`
  mutation usePianoRollOpacityMutation($opacity: Float!) {
    setPianoRollOpacity(opacity: $opacity)
  }
`;

const pianoRollOpacitySubscription = graphql`
  subscription usePianoRollOpacitySubscription {
    pianoRollOpacityChanged
  }
`;

export default function usePianoRollOpacity() {
  const { value: pianoRollOpacity, setValue: setPianoRollOpacity } =
    useSyncedServerFloat<
      usePianoRollOpacityQuery,
      usePianoRollOpacityMutation,
      usePianoRollOpacitySubscription
    >({
      query: pianoRollOpacityQuery,
      getQueryValue: (response) => response.pianoRollOpacity,
      mutation: pianoRollOpacityMutation,
      makeMutationVariables: (opacity) => ({ opacity }),
      subscription: pianoRollOpacitySubscription,
      getSubscriptionValue: (response) => response.pianoRollOpacityChanged,
      defaultValue: 1.0,
    });

  return { pianoRollOpacity, setPianoRollOpacity };
}
