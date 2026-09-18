import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
// fix doesn't fill the history with songs nobody sang. Overridable at
// runtime for the two cases that cross the split, testing on a packaged build
// and demoing from a dev one, and re-derived every launch, so an override
// can't outlive the session that wanted it.
//
// A discrete toggle, so commits go out immediately (no debounce), matching
// useExperimentalScoringEnabled.
//
// The local default is false rather than true on purpose: until the first
// fetch lands the true value is unknown, and briefly showing "not recording"
// when the room is recording is a harmless flicker, whereas the reverse would
// show a screen claiming a party is being recorded when it isn't.
export default function useHistoryRecordingEnabled() {
  const {
    value: historyRecordingEnabled,
    setValue: setHistoryRecordingEnabled,
  } = useSyncedServerValue<
    useHistoryRecordingEnabledQuery,
    useHistoryRecordingEnabledMutation,
    useHistoryRecordingEnabledSubscription,
    boolean
  >({
    query: historyRecordingEnabledQuery,
    getQueryValue: (response) => response.historyRecordingEnabled,
    mutation: historyRecordingEnabledMutation,
    makeMutationVariables: (enabled) => ({ enabled }),
    subscription: historyRecordingEnabledSubscription,
    getSubscriptionValue: (response) => response.historyRecordingEnabledChanged,
    defaultValue: false,
  });

  return { historyRecordingEnabled, setHistoryRecordingEnabled };
}
