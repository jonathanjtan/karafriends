import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { useBgmTrackMutation } from "./__generated__/useBgmTrackMutation.graphql";
import { useBgmTrackQuery } from "./__generated__/useBgmTrackQuery.graphql";
import { useBgmTrackSubscription } from "./__generated__/useBgmTrackSubscription.graphql";

const bgmTrackQuery = graphql`
  query useBgmTrackQuery {
    bgmTrack
  }
`;

const bgmTrackMutation = graphql`
  mutation useBgmTrackMutation($track: String) {
    setBgmTrack(track: $track)
  }
`;

const bgmTrackSubscription = graphql`
  subscription useBgmTrackSubscription {
    bgmTrackChanged
  }
`;

// The bundled BGM track filename (or shuffle sentinel) selected for
// between-song music, or null for none. Lives in the main process and stays
// live-synced across every renderer/remocon client. Unlike the slider-driven
// float settings (useSyncedServerFloat), a select changes value at most once
// per interaction, so commits go out immediately with no debounce.
export default function useBgmTrack() {
  const { value: bgmTrack, setValue: setBgmTrack } = useSyncedServerValue<
    useBgmTrackQuery,
    useBgmTrackMutation,
    useBgmTrackSubscription,
    string | null
  >({
    query: bgmTrackQuery,
    getQueryValue: (response) => response.bgmTrack ?? null,
    mutation: bgmTrackMutation,
    makeMutationVariables: (track) => ({ track }),
    subscription: bgmTrackSubscription,
    getSubscriptionValue: (response) => response.bgmTrackChanged ?? null,
    defaultValue: null,
  });

  return { bgmTrack, setBgmTrack };
}
