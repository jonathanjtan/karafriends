import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useSettingsCollapsedMutation } from "./__generated__/useSettingsCollapsedMutation.graphql";
import { useSettingsCollapsedQuery } from "./__generated__/useSettingsCollapsedQuery.graphql";
import { useSettingsCollapsedSubscription } from "./__generated__/useSettingsCollapsedSubscription.graphql";

const settingsCollapsedQuery = graphql`
  query useSettingsCollapsedQuery {
    settingsCollapsed
  }
`;

const settingsCollapsedMutation = graphql`
  mutation useSettingsCollapsedMutation($collapsed: Boolean!) {
    setSettingsCollapsed(collapsed: $collapsed)
  }
`;

const settingsCollapsedSubscription = graphql`
  subscription useSettingsCollapsedSubscription {
    settingsCollapsedChanged
  }
`;

// Whether the big-screen Settings section is collapsed. Lives in the main
// process and stays live-synced across every renderer/remocon client so the
// remocon can hide/show the TV's Settings section remotely. Like useBgmTrack,
// this is a discrete toggle, so commits go out immediately (no debounce).
export default function useSettingsCollapsed() {
  const [settingsCollapsed, setLocalSettingsCollapsed] = useState(false);
  const [commit] = useMutation<useSettingsCollapsedMutation>(
    settingsCollapsedMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useSettingsCollapsedQuery>(
        environment,
        settingsCollapsedQuery,
        {},
      ).subscribe({
        next: (response: useSettingsCollapsedQuery["response"]) =>
          setLocalSettingsCollapsed(response.settingsCollapsed),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useSettingsCollapsedQuery>(
      environment,
      settingsCollapsedQuery,
      {},
      (response) => setLocalSettingsCollapsed(response.settingsCollapsed),
    );

    const subscription = requestSubscription<useSettingsCollapsedSubscription>(
      environment,
      {
        subscription: settingsCollapsedSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalSettingsCollapsed(response.settingsCollapsedChanged);
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

  const setSettingsCollapsed = (collapsed: boolean) => {
    setLocalSettingsCollapsed(collapsed);
    commit({ variables: { collapsed } });
  };

  return { settingsCollapsed, setSettingsCollapsed };
}
