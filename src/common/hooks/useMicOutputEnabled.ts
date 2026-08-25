import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useMicOutputEnabledMutation } from "./__generated__/useMicOutputEnabledMutation.graphql";
import { useMicOutputEnabledQuery } from "./__generated__/useMicOutputEnabledQuery.graphql";
import { useMicOutputEnabledSubscription } from "./__generated__/useMicOutputEnabledSubscription.graphql";

const micOutputEnabledQuery = graphql`
  query useMicOutputEnabledQuery {
    micOutputEnabled
  }
`;

const micOutputEnabledMutation = graphql`
  mutation useMicOutputEnabledMutation($enabled: Boolean!) {
    setMicOutputEnabled(enabled: $enabled)
  }
`;

const micOutputEnabledSubscription = graphql`
  subscription useMicOutputEnabledSubscription {
    micOutputEnabledChanged
  }
`;

// Whether mic audio is played through the app's own speakers (the dry
// signal plus the reverb/echo). Turning it off mutes the mics locally so the
// room can run through an external mixer instead, while the native input
// stream keeps feeding the pitch detector, so scoring and the piano roll are
// unaffected. Defaults to on (the historical behavior). Like
// useQueueIntermissionEnabled, this is a discrete toggle, so commits go out
// immediately (no debounce).
export default function useMicOutputEnabled() {
  const [micOutputEnabled, setLocalMicOutputEnabled] = useState(true);
  const [commit] = useMutation<useMicOutputEnabledMutation>(
    micOutputEnabledMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useMicOutputEnabledQuery>(
        environment,
        micOutputEnabledQuery,
        {},
      ).subscribe({
        next: (response: useMicOutputEnabledQuery["response"]) =>
          setLocalMicOutputEnabled(response.micOutputEnabled),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useMicOutputEnabledQuery>(
      environment,
      micOutputEnabledQuery,
      {},
      (response) => setLocalMicOutputEnabled(response.micOutputEnabled),
    );

    const subscription = requestSubscription<useMicOutputEnabledSubscription>(
      environment,
      {
        subscription: micOutputEnabledSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalMicOutputEnabled(response.micOutputEnabledChanged);
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

  const setMicOutputEnabled = (enabled: boolean) => {
    setLocalMicOutputEnabled(enabled);
    commit({ variables: { enabled } });
  };

  return { micOutputEnabled, setMicOutputEnabled };
}
