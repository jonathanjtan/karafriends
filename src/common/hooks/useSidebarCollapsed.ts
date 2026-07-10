import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment from "../graphqlEnvironment";
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
  const [sidebarCollapsed, setLocalSidebarCollapsed] = useState(false);
  const [commit] = useMutation<useSidebarCollapsedMutation>(
    sidebarCollapsedMutation,
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useSidebarCollapsedQuery>(
        environment,
        sidebarCollapsedQuery,
        {},
      ).subscribe({
        next: (response: useSidebarCollapsedQuery["response"]) =>
          setLocalSidebarCollapsed(response.sidebarCollapsed),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initialQuery = fetchQuery<useSidebarCollapsedQuery>(
      environment,
      sidebarCollapsedQuery,
      {},
    ).subscribe({
      next: (response: useSidebarCollapsedQuery["response"]) =>
        setLocalSidebarCollapsed(response.sidebarCollapsed),
    });

    const subscription = requestSubscription<useSidebarCollapsedSubscription>(
      environment,
      {
        subscription: sidebarCollapsedSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalSidebarCollapsed(response.sidebarCollapsedChanged);
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  const setSidebarCollapsed = (collapsed: boolean) => {
    setLocalSidebarCollapsed(collapsed);
    commit({ variables: { collapsed } });
  };

  return { sidebarCollapsed, setSidebarCollapsed };
}
