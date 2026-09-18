import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
// idle mic ghost-draws the active singer's melody on the piano roll. The
// bleed is quiet but cleanly periodic. The gate discards those frames.
// Defaults to off (the historical behavior). Like useMicOutputEnabled, this
// is a discrete toggle, so commits go out immediately (no debounce).
export default function useMicRmsGateEnabled() {
  const { value: micRmsGateEnabled, setValue: setMicRmsGateEnabled } =
    useSyncedServerValue<
      useMicRmsGateEnabledQuery,
      useMicRmsGateEnabledMutation,
      useMicRmsGateEnabledSubscription,
      boolean
    >({
      query: micRmsGateEnabledQuery,
      getQueryValue: (response) => response.micRmsGateEnabled,
      mutation: micRmsGateEnabledMutation,
      makeMutationVariables: (enabled) => ({ enabled }),
      subscription: micRmsGateEnabledSubscription,
      getSubscriptionValue: (response) => response.micRmsGateEnabledChanged,
      defaultValue: false,
    });

  return { micRmsGateEnabled, setMicRmsGateEnabled };
}
