import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { usePitchShiftSemisMutation } from "./__generated__/usePitchShiftSemisMutation.graphql";
import { usePitchShiftSemisQuery } from "./__generated__/usePitchShiftSemisQuery.graphql";
import { usePitchShiftSemisSubscription } from "./__generated__/usePitchShiftSemisSubscription.graphql";

const pitchShiftSemisQuery = graphql`
  query usePitchShiftSemisQuery {
    pitchShiftSemis
  }
`;

const pitchShiftSemisMutation = graphql`
  mutation usePitchShiftSemisMutation($semis: Int!) {
    setPitchShiftSemis(semis: $semis)
  }
`;

const pitchShiftSemisSubscription = graphql`
  subscription usePitchShiftSemisSubscription {
    pitchShiftSemisChanged
  }
`;

type StateType = usePitchShiftSemisQuery["response"]["pitchShiftSemis"];

export default function usePitchShiftSemis() {
  const { value: pitchShiftSemis, setValue: setPitchShiftSemis } =
    useSyncedServerValue<
      usePitchShiftSemisQuery,
      usePitchShiftSemisMutation,
      usePitchShiftSemisSubscription,
      StateType
    >({
      query: pitchShiftSemisQuery,
      getQueryValue: (response) => response.pitchShiftSemis,
      mutation: pitchShiftSemisMutation,
      makeMutationVariables: (semis) => ({ semis }),
      subscription: pitchShiftSemisSubscription,
      getSubscriptionValue: (response) => response.pitchShiftSemisChanged,
      defaultValue: 0,
    });

  return { pitchShiftSemis, setPitchShiftSemis };
}
