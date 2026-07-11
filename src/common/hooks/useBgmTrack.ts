import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
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
  const [bgmTrack, setLocalBgmTrack] = useState<string | null>(null);
  const [commit] = useMutation<useBgmTrackMutation>(bgmTrackMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useBgmTrackQuery>(environment, bgmTrackQuery, {}).subscribe({
        next: (response: useBgmTrackQuery["response"]) =>
          setLocalBgmTrack(response.bgmTrack ?? null),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useBgmTrackQuery>(
      environment,
      bgmTrackQuery,
      {},
      (response) => setLocalBgmTrack(response.bgmTrack ?? null),
    );

    const subscription = requestSubscription<useBgmTrackSubscription>(
      environment,
      {
        subscription: bgmTrackSubscription,
        variables: {},
        onNext: (response) => {
          if (response) setLocalBgmTrack(response.bgmTrackChanged ?? null);
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

  const setBgmTrack = (track: string | null) => {
    setLocalBgmTrack(track);
    commit({ variables: { track } });
  };

  return { bgmTrack, setBgmTrack };
}
