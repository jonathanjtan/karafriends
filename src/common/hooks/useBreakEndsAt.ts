import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { useBreakEndsAtMutation } from "./__generated__/useBreakEndsAtMutation.graphql";
import { useBreakEndsAtQuery } from "./__generated__/useBreakEndsAtQuery.graphql";
import { useBreakEndsAtSubscription } from "./__generated__/useBreakEndsAtSubscription.graphql";

const breakEndsAtQuery = graphql`
  query useBreakEndsAtQuery {
    breakEndsAt
  }
`;

const breakEndsAtMutation = graphql`
  mutation useBreakEndsAtMutation($endsAt: Float) {
    setBreakEndsAt(endsAt: $endsAt)
  }
`;

const breakEndsAtSubscription = graphql`
  subscription useBreakEndsAtSubscription {
    breakEndsAtChanged
  }
`;

// Epoch ms when the current break ends, or null when not on break. While a
// break is active the renderer holds on the intermission screen instead of
// starting the next song. Lives in the main process and stays live-synced
// across every renderer/remocon client; set at most once per tap, so commits
// go out immediately (no debounce).
export default function useBreakEndsAt() {
  const { value: breakEndsAt, setValue: setBreakEndsAt } = useSyncedServerValue<
    useBreakEndsAtQuery,
    useBreakEndsAtMutation,
    useBreakEndsAtSubscription,
    number | null
  >({
    query: breakEndsAtQuery,
    getQueryValue: (response) => response.breakEndsAt ?? null,
    mutation: breakEndsAtMutation,
    makeMutationVariables: (endsAt) => ({ endsAt }),
    subscription: breakEndsAtSubscription,
    getSubscriptionValue: (response) => response.breakEndsAtChanged ?? null,
    defaultValue: null,
  });

  return { breakEndsAt, setBreakEndsAt };
}
