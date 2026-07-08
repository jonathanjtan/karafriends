import { graphql } from "react-relay";

import useSyncedServerFloat from "./useSyncedServerFloat";
import { useGuideMelodyVolumeMutation } from "./__generated__/useGuideMelodyVolumeMutation.graphql";
import { useGuideMelodyVolumeQuery } from "./__generated__/useGuideMelodyVolumeQuery.graphql";
import { useGuideMelodyVolumeSubscription } from "./__generated__/useGuideMelodyVolumeSubscription.graphql";

const guideMelodyVolumeQuery = graphql`
  query useGuideMelodyVolumeQuery {
    guideMelodyVolume
  }
`;

const guideMelodyVolumeMutation = graphql`
  mutation useGuideMelodyVolumeMutation($volume: Float!) {
    setGuideMelodyVolume(volume: $volume)
  }
`;

const guideMelodyVolumeSubscription = graphql`
  subscription useGuideMelodyVolumeSubscription {
    guideMelodyVolumeChanged
  }
`;

export default function useGuideMelodyVolume() {
  const { value: guideMelodyVolume, setValue: setGuideMelodyVolume } =
    useSyncedServerFloat<
      useGuideMelodyVolumeQuery,
      useGuideMelodyVolumeMutation,
      useGuideMelodyVolumeSubscription
    >({
      query: guideMelodyVolumeQuery,
      getQueryValue: (response) => response.guideMelodyVolume,
      mutation: guideMelodyVolumeMutation,
      makeMutationVariables: (volume) => ({ volume }),
      subscription: guideMelodyVolumeSubscription,
      getSubscriptionValue: (response) => response.guideMelodyVolumeChanged,
      defaultValue: 1.0,
    });

  return { guideMelodyVolume, setGuideMelodyVolume };
}
