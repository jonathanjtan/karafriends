import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useMicRmsGateEnabledMutation } from "./__generated__/useMicRmsGateEnabledMutation.graphql";
import { useMicRmsGateEnabledQuery } from "./__generated__/useMicRmsGateEnabledQuery.graphql";
import { useMicRmsGateEnabledSubscription } from "./__generated__/useMicRmsGateEnabledSubscription.graphql";

const micRmsGateEnabledQuery = graphql`
  query useMicRmsGateEnabledQuery {
    micRmsGateEnabled
  }
`;

const micRmsGateEnabledMutation = graphql`
  mutation useMicRmsGateEnabledMutation($enabled: Boolean!) {
    setMicRmsGateEnabled(enabled: $enabled)
  }
`;

const micRmsGateEnabledSubscription = graphql`
  subscription useMicRmsGateEnabledSubscription {
    micRmsGateEnabledChanged
  }
`;

// Whether pitch tracking ignores quiet mic signal (an absolute RMS floor).
// The pitch detector is amplitude-invariant, so when an external mixer's FX
// return (echo/reverb of every mic) bleeds into the per-mic channels, an
// idle mic ghost-draws the active singer's melody on the piano roll — the
// bleed is quiet but cleanly periodic. The gate discards those frames.
// Defaults to off (the historical behavior). Like useMicOutputEnabled, this
// is a discrete toggle, so commits go out immediately (no debounce).
export default function useMicRmsGateEnabled() {
  const [micRmsGateEnabled, setLocalMicRmsGateEnabled] = useState(false);
  const [commit] = useMutation<useMicRmsGateEnabledMutation>(
    micRmsGateEnabledMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useMicRmsGateEnabledQuery>(
        environment,
        micRmsGateEnabledQuery,
        {},
      ).subscribe({
        next: (response: useMicRmsGateEnabledQuery["response"]) =>
          setLocalMicRmsGateEnabled(response.micRmsGateEnabled),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useMicRmsGateEnabledQuery>(
      environment,
      micRmsGateEnabledQuery,
      {},
      (response) => setLocalMicRmsGateEnabled(response.micRmsGateEnabled),
    );

    const subscription = requestSubscription<useMicRmsGateEnabledSubscription>(
      environment,
      {
        subscription: micRmsGateEnabledSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalMicRmsGateEnabled(response.micRmsGateEnabledChanged);
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

  const setMicRmsGateEnabled = (enabled: boolean) => {
    setLocalMicRmsGateEnabled(enabled);
    commit({ variables: { enabled } });
  };

  return { micRmsGateEnabled, setMicRmsGateEnabled };
}
