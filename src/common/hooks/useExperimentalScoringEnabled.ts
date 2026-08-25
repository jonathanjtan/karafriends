import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useExperimentalScoringEnabledMutation } from "./__generated__/useExperimentalScoringEnabledMutation.graphql";
import { useExperimentalScoringEnabledQuery } from "./__generated__/useExperimentalScoringEnabledQuery.graphql";
import { useExperimentalScoringEnabledSubscription } from "./__generated__/useExperimentalScoringEnabledSubscription.graphql";

const experimentalScoringEnabledQuery = graphql`
  query useExperimentalScoringEnabledQuery {
    experimentalScoringEnabled
  }
`;

const experimentalScoringEnabledMutation = graphql`
  mutation useExperimentalScoringEnabledMutation($enabled: Boolean!) {
    setExperimentalScoringEnabled(enabled: $enabled)
  }
`;

const experimentalScoringEnabledSubscription = graphql`
  subscription useExperimentalScoringEnabledSubscription {
    experimentalScoringEnabledChanged
  }
`;

// EXPERIMENTAL: whether a song ending shows a performance score. Off by
// default. The formula (src/common/scoring.ts) is ours rather than DAM's,
// because the reference blob carries notes and phrase intervals but no scoring
// rules, so the numbers are not comparable to a commercial machine and are
// still being tuned. Only DAM and JOYSOUND songs carry the guide melody it
// needs; Youtube and Niconico simply never show a card.
//
// A discrete toggle, so commits go out immediately (no debounce), matching
// useMicRmsGateEnabled.
export default function useExperimentalScoringEnabled() {
  const [experimentalScoringEnabled, setLocalExperimentalScoringEnabled] =
    useState(false);
  const [commit] = useMutation<useExperimentalScoringEnabledMutation>(
    experimentalScoringEnabledMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useExperimentalScoringEnabledQuery>(
        environment,
        experimentalScoringEnabledQuery,
        {},
      ).subscribe({
        next: (response: useExperimentalScoringEnabledQuery["response"]) =>
          setLocalExperimentalScoringEnabled(
            response.experimentalScoringEnabled,
          ),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery =
      fetchQueryWithRetry<useExperimentalScoringEnabledQuery>(
        environment,
        experimentalScoringEnabledQuery,
        {},
        (response) =>
          setLocalExperimentalScoringEnabled(
            response.experimentalScoringEnabled,
          ),
      );

    const subscription =
      requestSubscription<useExperimentalScoringEnabledSubscription>(
        environment,
        {
          subscription: experimentalScoringEnabledSubscription,
          variables: {},
          onNext: (response) => {
            if (response)
              setLocalExperimentalScoringEnabled(
                response.experimentalScoringEnabledChanged,
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

  const setExperimentalScoringEnabled = (enabled: boolean) => {
    setLocalExperimentalScoringEnabled(enabled);
    commit({ variables: { enabled } });
  };

  return { experimentalScoringEnabled, setExperimentalScoringEnabled };
}
