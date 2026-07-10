import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment from "../graphqlEnvironment";
import { useQueueIntermissionEnabledMutation } from "./__generated__/useQueueIntermissionEnabledMutation.graphql";
import { useQueueIntermissionEnabledQuery } from "./__generated__/useQueueIntermissionEnabledQuery.graphql";
import { useQueueIntermissionEnabledSubscription } from "./__generated__/useQueueIntermissionEnabledSubscription.graphql";

const queueIntermissionEnabledQuery = graphql`
  query useQueueIntermissionEnabledQuery {
    queueIntermissionEnabled
  }
`;

const queueIntermissionEnabledMutation = graphql`
  mutation useQueueIntermissionEnabledMutation($enabled: Boolean!) {
    setQueueIntermissionEnabled(enabled: $enabled)
  }
`;

const queueIntermissionEnabledSubscription = graphql`
  subscription useQueueIntermissionEnabledSubscription {
    queueIntermissionEnabledChanged
  }
`;

// Whether the big screen cuts to a fullscreen queue screen for a few seconds
// between songs (like a real DAM/JOYSOUND machine) before starting the next
// song. Lives in the main process and stays live-synced across every
// renderer/remocon client. Like useSettingsCollapsed, this is a discrete
// toggle, so commits go out immediately (no debounce).
export default function useQueueIntermissionEnabled() {
  const [queueIntermissionEnabled, setLocalQueueIntermissionEnabled] =
    useState(false);
  const [commit] = useMutation<useQueueIntermissionEnabledMutation>(
    queueIntermissionEnabledMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useQueueIntermissionEnabledQuery>(
        environment,
        queueIntermissionEnabledQuery,
        {},
      ).subscribe({
        next: (response: useQueueIntermissionEnabledQuery["response"]) =>
          setLocalQueueIntermissionEnabled(response.queueIntermissionEnabled),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initialQuery = fetchQuery<useQueueIntermissionEnabledQuery>(
      environment,
      queueIntermissionEnabledQuery,
      {},
    ).subscribe({
      next: (response: useQueueIntermissionEnabledQuery["response"]) =>
        setLocalQueueIntermissionEnabled(response.queueIntermissionEnabled),
    });

    const subscription =
      requestSubscription<useQueueIntermissionEnabledSubscription>(
        environment,
        {
          subscription: queueIntermissionEnabledSubscription,
          variables: {},
          onNext: (response) => {
            if (response)
              setLocalQueueIntermissionEnabled(
                response.queueIntermissionEnabledChanged,
              );
          },
        },
      );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  const setQueueIntermissionEnabled = (enabled: boolean) => {
    setLocalQueueIntermissionEnabled(enabled);
    commit({ variables: { enabled } });
  };

  return { queueIntermissionEnabled, setQueueIntermissionEnabled };
}
