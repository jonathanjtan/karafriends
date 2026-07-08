import { useEffect, useRef, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment from "../graphqlEnvironment";
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

// Matches the server-side default until the initial query resolves.
const DEFAULT_GUIDE_MELODY_VOLUME = 1.0;

// Volume sliders fire continuously while dragging; batch the resulting
// mutations so the server isn't hit dozens of times per drag.
const COMMIT_DEBOUNCE_MS = 200;

interface PendingCommit {
  timeout: ReturnType<typeof setTimeout>;
  volume: number;
}

export default function useGuideMelodyVolume() {
  const [guideMelodyVolume, setLocalGuideMelodyVolume] = useState<number>(
    DEFAULT_GUIDE_MELODY_VOLUME,
  );
  const [commit] = useMutation<useGuideMelodyVolumeMutation>(
    guideMelodyVolumeMutation,
  );
  const pendingCommit = useRef<PendingCommit | null>(null);

  useEffect(() => {
    function applyRemoteVolume(volume: number) {
      // While a local change is waiting to be committed, remote values are
      // stale echoes of earlier commits; the local value wins.
      if (pendingCommit.current !== null) return;
      setLocalGuideMelodyVolume(volume);
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useGuideMelodyVolumeQuery>(
        environment,
        guideMelodyVolumeQuery,
        {},
      ).subscribe({
        next: (response: useGuideMelodyVolumeQuery["response"]) =>
          applyRemoteVolume(response.guideMelodyVolume),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initialQuery = fetchQuery<useGuideMelodyVolumeQuery>(
      environment,
      guideMelodyVolumeQuery,
      {},
    ).subscribe({
      next: (response: useGuideMelodyVolumeQuery["response"]) =>
        applyRemoteVolume(response.guideMelodyVolume),
    });

    const subscription = requestSubscription<useGuideMelodyVolumeSubscription>(
      environment,
      {
        subscription: guideMelodyVolumeSubscription,
        variables: {},
        onNext: (response) => {
          if (response) applyRemoteVolume(response.guideMelodyVolumeChanged);
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

  const setGuideMelodyVolume = (volume: number) => {
    setLocalGuideMelodyVolume(volume);
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

  return { guideMelodyVolume, setGuideMelodyVolume };
}
