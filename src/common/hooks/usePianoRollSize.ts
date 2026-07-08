import { graphql } from "react-relay";

import useSyncedServerFloat from "./useSyncedServerFloat";
import { usePianoRollSizeMutation } from "./__generated__/usePianoRollSizeMutation.graphql";
import { usePianoRollSizeQuery } from "./__generated__/usePianoRollSizeQuery.graphql";
import { usePianoRollSizeSubscription } from "./__generated__/usePianoRollSizeSubscription.graphql";

const pianoRollSizeQuery = graphql`
  query usePianoRollSizeQuery {
    pianoRollSize
  }
`;

const pianoRollSizeMutation = graphql`
  mutation usePianoRollSizeMutation($size: Float!) {
    setPianoRollSize(size: $size)
  }
`;

const pianoRollSizeSubscription = graphql`
  subscription usePianoRollSizeSubscription {
    pianoRollSizeChanged
  }
`;

// Height of the piano roll as a fraction of the player screen.
export default function usePianoRollSize() {
  const { value: pianoRollSize, setValue: setPianoRollSize } =
    useSyncedServerFloat<
      usePianoRollSizeQuery,
      usePianoRollSizeMutation,
      usePianoRollSizeSubscription
    >({
      query: pianoRollSizeQuery,
      getQueryValue: (response) => response.pianoRollSize,
      mutation: pianoRollSizeMutation,
      makeMutationVariables: (size) => ({ size }),
      subscription: pianoRollSizeSubscription,
      getSubscriptionValue: (response) => response.pianoRollSizeChanged,
      defaultValue: 0.3,
    });

  return { pianoRollSize, setPianoRollSize };
}
