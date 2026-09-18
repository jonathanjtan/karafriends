import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
// default. The scoring formula (src/common/scoring.ts) is not DAM's, because
// the reference blob carries notes and phrase intervals but no scoring rules,
// so the numbers are not comparable to a commercial machine and are still
// being tuned. Only DAM and JOYSOUND songs carry the guide melody it needs;
// Youtube and Niconico never show a card.
//
// A discrete toggle, so commits go out immediately (no debounce), matching
// useMicRmsGateEnabled.
export default function useExperimentalScoringEnabled() {
  const {
    value: experimentalScoringEnabled,
    setValue: setExperimentalScoringEnabled,
  } = useSyncedServerValue<
    useExperimentalScoringEnabledQuery,
    useExperimentalScoringEnabledMutation,
    useExperimentalScoringEnabledSubscription,
    boolean
  >({
    query: experimentalScoringEnabledQuery,
    getQueryValue: (response) => response.experimentalScoringEnabled,
    mutation: experimentalScoringEnabledMutation,
    makeMutationVariables: (enabled) => ({ enabled }),
    subscription: experimentalScoringEnabledSubscription,
    getSubscriptionValue: (response) =>
      response.experimentalScoringEnabledChanged,
    defaultValue: false,
  });

  return { experimentalScoringEnabled, setExperimentalScoringEnabled };
}
