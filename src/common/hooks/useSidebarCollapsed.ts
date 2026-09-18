import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { useSidebarCollapsedMutation } from "./__generated__/useSidebarCollapsedMutation.graphql";
import { useSidebarCollapsedQuery } from "./__generated__/useSidebarCollapsedQuery.graphql";
import { useSidebarCollapsedSubscription } from "./__generated__/useSidebarCollapsedSubscription.graphql";

const sidebarCollapsedQuery = graphql`
  query useSidebarCollapsedQuery {
    sidebarCollapsed
  }
`;

const sidebarCollapsedMutation = graphql`
  mutation useSidebarCollapsedMutation($collapsed: Boolean!) {
    setSidebarCollapsed(collapsed: $collapsed)
  }
`;

const sidebarCollapsedSubscription = graphql`
  subscription useSidebarCollapsedSubscription {
    sidebarCollapsedChanged
  }
`;

// Whether the big-screen sidebar (QR + Settings + Queue) is hidden so the
// playing song can go fullscreen. Lives in the main process and stays
// live-synced across every renderer/remocon client so the remocon can
// hide/show the TV's sidebar remotely. Like useSettingsCollapsed, this is a
// discrete toggle, so commits go out immediately (no debounce).
export default function useSidebarCollapsed() {
  const { value: sidebarCollapsed, setValue: setSidebarCollapsed } =
    useSyncedServerValue<
      useSidebarCollapsedQuery,
      useSidebarCollapsedMutation,
      useSidebarCollapsedSubscription,
      boolean
    >({
      query: sidebarCollapsedQuery,
      getQueryValue: (response) => response.sidebarCollapsed,
      mutation: sidebarCollapsedMutation,
      makeMutationVariables: (collapsed) => ({ collapsed }),
      subscription: sidebarCollapsedSubscription,
      getSubscriptionValue: (response) => response.sidebarCollapsedChanged,
      defaultValue: false,
    });

  return { sidebarCollapsed, setSidebarCollapsed };
}
