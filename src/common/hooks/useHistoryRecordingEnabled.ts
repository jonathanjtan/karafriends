import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useHistoryRecordingEnabledMutation } from "./__generated__/useHistoryRecordingEnabledMutation.graphql";
import { useHistoryRecordingEnabledQuery } from "./__generated__/useHistoryRecordingEnabledQuery.graphql";
import { useHistoryRecordingEnabledSubscription } from "./__generated__/useHistoryRecordingEnabledSubscription.graphql";

const historyRecordingEnabledQuery = graphql`
  query useHistoryRecordingEnabledQuery {
    historyRecordingEnabled
  }
`;

const historyRecordingEnabledMutation = graphql`
  mutation useHistoryRecordingEnabledMutation($enabled: Boolean!) {
    setHistoryRecordingEnabled(enabled: $enabled)
  }
`;

const historyRecordingEnabledSubscription = graphql`
  subscription useHistoryRecordingEnabledSubscription {
    historyRecordingEnabledChanged
  }
`;

// Whether a played song is written to songHistory. The default comes from
// whether this is a packaged build (main's DEFAULT_HISTORY_RECORDING): parties
// run the packaged app and development doesn't, so testing a download or a sync
// fix doesn't quietly fill the history with songs nobody sang. Overridable at
// runtime for the two cases that cross the split -- testing on a packaged
// build, demoing from a dev one -- and re-derived every launch, so an override
// can't outlive the session that wanted it.
//
// A discrete toggle, so commits go out immediately (no debounce), matching
// useExperimentalScoringEnabled.
//
// The local default is false rather than true on purpose: until the first fetch
// lands we don't know, and briefly showing "not recording" when we are is a
// harmless flicker, where the reverse would be a screen that claims a party is
// being recorded when it isn't.
export default function useHistoryRecordingEnabled() {
  const [historyRecordingEnabled, setLocalHistoryRecordingEnabled] =
    useState(false);
  const [commit] = useMutation<useHistoryRecordingEnabledMutation>(
    historyRecordingEnabledMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useHistoryRecordingEnabledQuery>(
        environment,
        historyRecordingEnabledQuery,
        {},
      ).subscribe({
        next: (response: useHistoryRecordingEnabledQuery["response"]) =>
          setLocalHistoryRecordingEnabled(response.historyRecordingEnabled),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useHistoryRecordingEnabledQuery>(
      environment,
      historyRecordingEnabledQuery,
      {},
      (response) =>
        setLocalHistoryRecordingEnabled(response.historyRecordingEnabled),
    );

    const subscription =
      requestSubscription<useHistoryRecordingEnabledSubscription>(environment, {
        subscription: historyRecordingEnabledSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalHistoryRecordingEnabled(
              response.historyRecordingEnabledChanged,
            );
        },
      });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  const setHistoryRecordingEnabled = (enabled: boolean) => {
    setLocalHistoryRecordingEnabled(enabled);
    commit({ variables: { enabled } });
  };

  return { historyRecordingEnabled, setHistoryRecordingEnabled };
}
