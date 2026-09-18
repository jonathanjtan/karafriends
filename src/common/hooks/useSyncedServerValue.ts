import { useEffect, useState } from "react";
import { fetchQuery, requestSubscription, useMutation } from "react-relay";
import {
  GraphQLTaggedNode,
  MutationParameters,
  OperationType,
} from "relay-runtime";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";

// Shared plumbing for a setting that lives in the main process and stays
// live-synced across every renderer/remocon client: initial fetch (with
// retry), refetch on tab focus and on WS reconnect, a subscription for
// remote changes, and an immediate (undebounced) mutation for local changes.
// Relay requires the graphql`` documents to be static, so each concrete hook
// declares its own three operations and hands them in here. Sliders use
// useSyncedServerFloat instead, which adds commit debouncing.
export default function useSyncedServerValue<
  TQuery extends OperationType,
  TMutation extends MutationParameters,
  TSubscription extends OperationType,
  TValue,
>(config: {
  query: GraphQLTaggedNode;
  getQueryValue: (response: TQuery["response"]) => TValue;
  mutation: GraphQLTaggedNode;
  makeMutationVariables: (value: TValue) => TMutation["variables"];
  subscription: GraphQLTaggedNode;
  getSubscriptionValue: (response: TSubscription["response"]) => TValue;
  defaultValue: TValue;
}) {
  const [value, setLocalValue] = useState<TValue>(config.defaultValue);
  const [commit] = useMutation<TMutation>(config.mutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<TQuery>(environment, config.query, {}).subscribe({
        next: (response: TQuery["response"]) =>
          setLocalValue(config.getQueryValue(response)),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<TQuery>(
      environment,
      config.query,
      {},
      (response) => setLocalValue(config.getQueryValue(response)),
    );

    const subscription = requestSubscription<TSubscription>(environment, {
      subscription: config.subscription,
      variables: {},
      onNext: (response) => {
        if (response) setLocalValue(config.getSubscriptionValue(response));
      },
    });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  const setValue = (newValue: TValue) => {
    setLocalValue(newValue);
    commit({ variables: config.makeMutationVariables(newValue) });
  };

  return { value, setValue };
}
