import { graphql } from "react-relay";

import { DEFAULT_MIC_RMS_GATE_THRESHOLD } from "../constants";
import useSyncedServerFloat from "./useSyncedServerFloat";
import { useMicRmsGateThresholdMutation } from "./__generated__/useMicRmsGateThresholdMutation.graphql";
import { useMicRmsGateThresholdQuery } from "./__generated__/useMicRmsGateThresholdQuery.graphql";
import { useMicRmsGateThresholdSubscription } from "./__generated__/useMicRmsGateThresholdSubscription.graphql";

const micRmsGateThresholdQuery = graphql`
  query useMicRmsGateThresholdQuery {
    micRmsGateThreshold
  }
`;

const micRmsGateThresholdMutation = graphql`
  mutation useMicRmsGateThresholdMutation($threshold: Float!) {
    setMicRmsGateThreshold(threshold: $threshold)
  }
`;

const micRmsGateThresholdSubscription = graphql`
  subscription useMicRmsGateThresholdSubscription {
    micRmsGateThresholdChanged
  }
`;

// The RMS floor the Pitch Gate applies, linear full-scale. Only has an effect
// while micRmsGateEnabled is on; see the constants for why it is tunable.
export default function useMicRmsGateThreshold() {
  const { value: micRmsGateThreshold, setValue: setMicRmsGateThreshold } =
    useSyncedServerFloat<
      useMicRmsGateThresholdQuery,
      useMicRmsGateThresholdMutation,
      useMicRmsGateThresholdSubscription
    >({
      query: micRmsGateThresholdQuery,
      getQueryValue: (response) => response.micRmsGateThreshold,
      mutation: micRmsGateThresholdMutation,
      makeMutationVariables: (threshold) => ({ threshold }),
      subscription: micRmsGateThresholdSubscription,
      getSubscriptionValue: (response) => response.micRmsGateThresholdChanged,
      defaultValue: DEFAULT_MIC_RMS_GATE_THRESHOLD,
    });

  return { micRmsGateThreshold, setMicRmsGateThreshold };
}
