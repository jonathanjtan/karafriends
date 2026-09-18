import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
  const {
    value: queueIntermissionEnabled,
    setValue: setQueueIntermissionEnabled,
  } = useSyncedServerValue<
    useQueueIntermissionEnabledQuery,
    useQueueIntermissionEnabledMutation,
    useQueueIntermissionEnabledSubscription,
    boolean
  >({
    query: queueIntermissionEnabledQuery,
    getQueryValue: (response) => response.queueIntermissionEnabled,
    mutation: queueIntermissionEnabledMutation,
    makeMutationVariables: (enabled) => ({ enabled }),
    subscription: queueIntermissionEnabledSubscription,
    getSubscriptionValue: (response) =>
      response.queueIntermissionEnabledChanged,
    defaultValue: false,
  });

  return { queueIntermissionEnabled, setQueueIntermissionEnabled };
}
