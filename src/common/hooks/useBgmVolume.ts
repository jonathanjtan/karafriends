import { useEffect, useRef, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment from "../graphqlEnvironment";
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

// Matches the server-side default until the initial query resolves.
const DEFAULT_BGM_VOLUME = 0.3;

// Volume sliders fire continuously while dragging; batch the resulting
// mutations so the server isn't hit dozens of times per drag.
const COMMIT_DEBOUNCE_MS = 200;

interface PendingCommit {
  timeout: ReturnType<typeof setTimeout>;
  volume: number;
}

export default function useBgmVolume() {
  const [bgmVolume, setLocalBgmVolume] = useState<number>(DEFAULT_BGM_VOLUME);
  const [commit] = useMutation<useBgmVolumeMutation>(bgmVolumeMutation);
  const pendingCommit = useRef<PendingCommit | null>(null);

  useEffect(() => {
    function applyRemoteVolume(volume: number) {
      // While a local change is waiting to be committed, remote values are
      // stale echoes of earlier commits; the local value wins.
      if (pendingCommit.current !== null) return;
      setLocalBgmVolume(volume);
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useBgmVolumeQuery>(environment, bgmVolumeQuery, {}).subscribe({
        next: (response: useBgmVolumeQuery["response"]) =>
          applyRemoteVolume(response.bgmVolume),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initialQuery = fetchQuery<useBgmVolumeQuery>(
      environment,
      bgmVolumeQuery,
      {},
    ).subscribe({
      next: (response: useBgmVolumeQuery["response"]) =>
        applyRemoteVolume(response.bgmVolume),
    });

    const subscription = requestSubscription<useBgmVolumeSubscription>(
      environment,
      {
        subscription: bgmVolumeSubscription,
        variables: {},
        onNext: (response) => {
          if (response) applyRemoteVolume(response.bgmVolumeChanged);
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();

      // Don't lose a change made right before unmount.
      if (pendingCommit.current !== null) {
        clearTimeout(pendingCommit.current.timeout);
        commit({ variables: { volume: pendingCommit.current.volume } });
        pendingCommit.current = null;
      }
    };
  }, []);

  const setBgmVolume = (volume: number) => {
    setLocalBgmVolume(volume);
    if (pendingCommit.current !== null) {
      clearTimeout(pendingCommit.current.timeout);
    }
    pendingCommit.current = {
      timeout: setTimeout(() => {
        pendingCommit.current = null;
        commit({ variables: { volume } });
      }, COMMIT_DEBOUNCE_MS),
      volume,
    };
  };

  return { bgmVolume, setBgmVolume };
}
