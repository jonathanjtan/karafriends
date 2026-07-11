import { useEffect, useRef, useState } from "react";
import { fetchQuery, requestSubscription, useMutation } from "react-relay";
import {
  GraphQLTaggedNode,
  MutationParameters,
  OperationType,
} from "relay-runtime";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";

// Sliders fire continuously while dragging; batch the resulting mutations
// so the server isn't hit dozens of times per drag.
const COMMIT_DEBOUNCE_MS = 200;

interface PendingCommit {
  timeout: ReturnType<typeof setTimeout>;
  value: number;
}

// Shared plumbing for a numeric setting that lives in the main process and
// stays live-synced across every renderer/remocon client: initial fetch,
// refetch on tab focus, subscription for remote changes, and a debounced
// mutation for local changes. Relay requires the graphql`` documents to be
// static, so each concrete hook declares its own three operations and hands
// them in here.
export default function useSyncedServerFloat<
  TQuery extends OperationType,
  TMutation extends MutationParameters,
  TSubscription extends OperationType,
>(config: {
  query: GraphQLTaggedNode;
  getQueryValue: (response: TQuery["response"]) => number;
  mutation: GraphQLTaggedNode;
  makeMutationVariables: (value: number) => TMutation["variables"];
  subscription: GraphQLTaggedNode;
  getSubscriptionValue: (response: TSubscription["response"]) => number;
  // Should match the server-side default, so the UI is right until the
  // initial query resolves.
  defaultValue: number;
}) {
  const [value, setLocalValue] = useState<number>(config.defaultValue);
  const [commit] = useMutation<TMutation>(config.mutation);
  const pendingCommit = useRef<PendingCommit | null>(null);

  useEffect(() => {
    function applyRemoteValue(remoteValue: number) {
      // While a local change is waiting to be committed, remote values are
      // stale echoes of earlier commits; the local value wins.
      if (pendingCommit.current !== null) return;
      setLocalValue(remoteValue);
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<TQuery>(environment, config.query, {}).subscribe({
        next: (response: TQuery["response"]) =>
          applyRemoteValue(config.getQueryValue(response)),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<TQuery>(
      environment,
      config.query,
      {},
      (response) => applyRemoteValue(config.getQueryValue(response)),
    );

    const subscription = requestSubscription<TSubscription>(environment, {
      subscription: config.subscription,
      variables: {},
      onNext: (response) => {
        if (response) applyRemoteValue(config.getSubscriptionValue(response));
      },
    });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();

      // Don't lose a change made right before unmount.
      if (pendingCommit.current !== null) {
        clearTimeout(pendingCommit.current.timeout);
        commit({
          variables: config.makeMutationVariables(pendingCommit.current.value),
        });
        pendingCommit.current = null;
      }
    };
  }, []);

  const setValue = (newValue: number) => {
    setLocalValue(newValue);
    if (pendingCommit.current !== null) {
      clearTimeout(pendingCommit.current.timeout);
    }
    pendingCommit.current = {
      timeout: setTimeout(() => {
        pendingCommit.current = null;
        commit({ variables: config.makeMutationVariables(newValue) });
      }, COMMIT_DEBOUNCE_MS),
      value: newValue,
    };
  };

  return { value, setValue };
}
