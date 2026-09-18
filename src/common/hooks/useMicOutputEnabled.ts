import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
import { useMicOutputEnabledMutation } from "./__generated__/useMicOutputEnabledMutation.graphql";
import { useMicOutputEnabledQuery } from "./__generated__/useMicOutputEnabledQuery.graphql";
import { useMicOutputEnabledSubscription } from "./__generated__/useMicOutputEnabledSubscription.graphql";

const micOutputEnabledQuery = graphql`
  query useMicOutputEnabledQuery {
    micOutputEnabled
  }
`;

const micOutputEnabledMutation = graphql`
  mutation useMicOutputEnabledMutation($enabled: Boolean!) {
    setMicOutputEnabled(enabled: $enabled)
  }
`;

const micOutputEnabledSubscription = graphql`
  subscription useMicOutputEnabledSubscription {
    micOutputEnabledChanged
  }
`;

// Whether mic audio is played through the app's own speakers (the dry
// signal plus the reverb/echo). Turning it off mutes the mics locally so the
// room can run through an external mixer instead, while the native input
// stream keeps feeding the pitch detector, so scoring and the piano roll are
// unaffected. Defaults to on (the historical behavior). Like
// useQueueIntermissionEnabled, this is a discrete toggle, so commits go out
// immediately (no debounce).
export default function useMicOutputEnabled() {
  const { value: micOutputEnabled, setValue: setMicOutputEnabled } =
    useSyncedServerValue<
      useMicOutputEnabledQuery,
      useMicOutputEnabledMutation,
      useMicOutputEnabledSubscription,
      boolean
    >({
      query: micOutputEnabledQuery,
      getQueryValue: (response) => response.micOutputEnabled,
      mutation: micOutputEnabledMutation,
      makeMutationVariables: (enabled) => ({ enabled }),
      subscription: micOutputEnabledSubscription,
      getSubscriptionValue: (response) => response.micOutputEnabledChanged,
      defaultValue: true,
    });

  return { micOutputEnabled, setMicOutputEnabled };
}
