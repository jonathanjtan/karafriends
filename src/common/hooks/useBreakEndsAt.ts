import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
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
  const [breakEndsAt, setLocalBreakEndsAt] = useState<number | null>(null);
  const [commit] = useMutation<useBreakEndsAtMutation>(breakEndsAtMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useBreakEndsAtQuery>(
        environment,
        breakEndsAtQuery,
        {},
      ).subscribe({
        next: (response: useBreakEndsAtQuery["response"]) =>
          setLocalBreakEndsAt(response.breakEndsAt ?? null),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useBreakEndsAtQuery>(
      environment,
      breakEndsAtQuery,
      {},
      (response) => setLocalBreakEndsAt(response.breakEndsAt ?? null),
    );

    const subscription = requestSubscription<useBreakEndsAtSubscription>(
      environment,
      {
        subscription: breakEndsAtSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalBreakEndsAt(response.breakEndsAtChanged ?? null);
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

  const setBreakEndsAt = (endsAt: number | null) => {
    setLocalBreakEndsAt(endsAt);
    commit({ variables: { endsAt } });
  };

  return { breakEndsAt, setBreakEndsAt };
}
