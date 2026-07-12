import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useOledFriendlyMutation } from "./__generated__/useOledFriendlyMutation.graphql";
import { useOledFriendlyQuery } from "./__generated__/useOledFriendlyQuery.graphql";
import { useOledFriendlySubscription } from "./__generated__/useOledFriendlySubscription.graphql";

const oledFriendlyQuery = graphql`
  query useOledFriendlyQuery {
    oledFriendly
  }
`;

const oledFriendlyMutation = graphql`
  mutation useOledFriendlyMutation($oledFriendly: Boolean!) {
    setOledFriendly(oledFriendly: $oledFriendly)
  }
`;

const oledFriendlySubscription = graphql`
  subscription useOledFriendlySubscription {
    oledFriendlyChanged
  }
`;

// Whether the big screen uses the dark OLED-friendly theme. Lives in the main
// process and stays live-synced across every renderer/remocon client so the
// remocon can toggle it on the TV remotely. A discrete toggle, so commits go
// out immediately (no debounce).
export default function useOledFriendly() {
  const [oledFriendly, setLocalOledFriendly] = useState(false);
  const [commit] = useMutation<useOledFriendlyMutation>(oledFriendlyMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useOledFriendlyQuery>(
        environment,
        oledFriendlyQuery,
        {},
      ).subscribe({
        next: (response: useOledFriendlyQuery["response"]) =>
          setLocalOledFriendly(response.oledFriendly),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useOledFriendlyQuery>(
      environment,
      oledFriendlyQuery,
      {},
      (response) => setLocalOledFriendly(response.oledFriendly),
    );

    const subscription = requestSubscription<useOledFriendlySubscription>(
      environment,
      {
        subscription: oledFriendlySubscription,
        variables: {},
        onNext: (response) => {
          if (response) setLocalOledFriendly(response.oledFriendlyChanged);
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

  const setOledFriendly = (value: boolean) => {
    setLocalOledFriendly(value);
    commit({ variables: { oledFriendly: value } });
  };

  return { oledFriendly, setOledFriendly };
}
