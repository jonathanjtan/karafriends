import { graphql } from "react-relay";

import useSyncedServerFloat from "./useSyncedServerFloat";
import { useBgmVolumeMutation } from "./__generated__/useBgmVolumeMutation.graphql";
import { useBgmVolumeQuery } from "./__generated__/useBgmVolumeQuery.graphql";
import { useBgmVolumeSubscription } from "./__generated__/useBgmVolumeSubscription.graphql";

const bgmVolumeQuery = graphql`
  query useBgmVolumeQuery {
    bgmVolume
  }
`;

const bgmVolumeMutation = graphql`
  mutation useBgmVolumeMutation($volume: Float!) {
    setBgmVolume(volume: $volume)
  }
`;

const bgmVolumeSubscription = graphql`
  subscription useBgmVolumeSubscription {
    bgmVolumeChanged
  }
`;

export default function useBgmVolume() {
  const { value: bgmVolume, setValue: setBgmVolume } = useSyncedServerFloat<
    useBgmVolumeQuery,
    useBgmVolumeMutation,
    useBgmVolumeSubscription
  >({
    query: bgmVolumeQuery,
    getQueryValue: (response) => response.bgmVolume,
    mutation: bgmVolumeMutation,
    makeMutationVariables: (volume) => ({ volume }),
    subscription: bgmVolumeSubscription,
    getSubscriptionValue: (response) => response.bgmVolumeChanged,
    defaultValue: 0.3,
  });

  return { bgmVolume, setBgmVolume };
}
