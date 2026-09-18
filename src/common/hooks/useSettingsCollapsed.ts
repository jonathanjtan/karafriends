import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
  const { value: settingsCollapsed, setValue: setSettingsCollapsed } =
    useSyncedServerValue<
      useSettingsCollapsedQuery,
      useSettingsCollapsedMutation,
      useSettingsCollapsedSubscription,
      boolean
    >({
      query: settingsCollapsedQuery,
      getQueryValue: (response) => response.settingsCollapsed,
      mutation: settingsCollapsedMutation,
      makeMutationVariables: (collapsed) => ({ collapsed }),
      subscription: settingsCollapsedSubscription,
      getSubscriptionValue: (response) => response.settingsCollapsedChanged,
      defaultValue: false,
    });

  return { settingsCollapsed, setSettingsCollapsed };
}
