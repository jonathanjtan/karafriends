import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useHostnameMutation } from "./__generated__/useHostnameMutation.graphql";
import { useHostnameQuery } from "./__generated__/useHostnameQuery.graphql";
import { useHostnameSubscription } from "./__generated__/useHostnameSubscription.graphql";

const hostnameQuery = graphql`
  query useHostnameQuery {
    hostname
  }
`;

const hostnameMutation = graphql`
  mutation useHostnameMutation($hostname: String!) {
    setHostname(hostname: $hostname)
  }
`;

const hostnameSubscription = graphql`
  subscription useHostnameSubscription {
    hostnameChanged
  }
`;

// The "host:port" the QR codes encode. Owned by the main process (which
// computes the LAN default) so every window that draws a QR agrees without
// any renderer-to-renderer relay: the sidebar, the intermission screen and
// the popped-out QR window all just read this. Empty string until the first
// fetch lands — callers should skip drawing a QR for it rather than encode a
// bogus URL. Like useBgmTrack, a picker changes value at most once per
// interaction, so commits go out immediately with no debounce.
export default function useHostname() {
  const [hostname, setLocalHostname] = useState("");
  const [commit] = useMutation<useHostnameMutation>(hostnameMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useHostnameQuery>(environment, hostnameQuery, {}).subscribe({
        next: (response: useHostnameQuery["response"]) =>
          setLocalHostname(response.hostname),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useHostnameQuery>(
      environment,
      hostnameQuery,
      {},
      (response) => setLocalHostname(response.hostname),
    );

    const subscription = requestSubscription<useHostnameSubscription>(
      environment,
      {
        subscription: hostnameSubscription,
        variables: {},
        onNext: (response) => {
          if (response) setLocalHostname(response.hostnameChanged);
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

  const setHostname = (next: string) => {
    setLocalHostname(next);
    commit({ variables: { hostname: next } });
  };

  return { hostname, setHostname };
}
