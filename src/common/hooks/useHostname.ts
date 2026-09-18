import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
// fetch lands, so callers should skip drawing a QR for it rather than encode a
// bogus URL. Like useBgmTrack, a picker changes value at most once per
// interaction, so commits go out immediately with no debounce.
export default function useHostname() {
  const { value: hostname, setValue: setHostname } = useSyncedServerValue<
    useHostnameQuery,
    useHostnameMutation,
    useHostnameSubscription,
    string
  >({
    query: hostnameQuery,
    getQueryValue: (response) => response.hostname,
    mutation: hostnameMutation,
    makeMutationVariables: (next) => ({ hostname: next }),
    subscription: hostnameSubscription,
    getSubscriptionValue: (response) => response.hostnameChanged,
    defaultValue: "",
  });

  return { hostname, setHostname };
}
