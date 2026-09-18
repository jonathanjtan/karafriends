import { graphql } from "react-relay";

import useSyncedServerValue from "./useSyncedServerValue";
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
  const { value: oledFriendly, setValue: setOledFriendly } =
    useSyncedServerValue<
      useOledFriendlyQuery,
      useOledFriendlyMutation,
      useOledFriendlySubscription,
      boolean
    >({
      query: oledFriendlyQuery,
      getQueryValue: (response) => response.oledFriendly,
      mutation: oledFriendlyMutation,
      makeMutationVariables: (value) => ({ oledFriendly: value }),
      subscription: oledFriendlySubscription,
      getSubscriptionValue: (response) => response.oledFriendlyChanged,
      defaultValue: false,
    });

  return { oledFriendly, setOledFriendly };
}
