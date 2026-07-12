import { useEffect, useState } from "react";
import {
  fetchQuery,
  graphql,
  requestSubscription,
  useMutation,
} from "react-relay";

import environment, { WS_RECONNECTED_EVENT } from "../graphqlEnvironment";
import fetchQueryWithRetry from "./fetchQueryWithRetry";
import { useBreakMessageMutation } from "./__generated__/useBreakMessageMutation.graphql";
import { useBreakMessageQuery } from "./__generated__/useBreakMessageQuery.graphql";
import { useBreakMessageSubscription } from "./__generated__/useBreakMessageSubscription.graphql";

const breakMessageQuery = graphql`
  query useBreakMessageQuery {
    breakMessage {
      text
      author
    }
  }
`;

const breakMessageMutation = graphql`
  mutation useBreakMessageMutation($text: String, $author: String) {
    setBreakMessage(text: $text, author: $author)
  }
`;

const breakMessageSubscription = graphql`
  subscription useBreakMessageSubscription {
    breakMessageChanged {
      text
      author
    }
  }
`;

export type BreakMessage = { text: string; author: string | null };

function normalizeBreakMessage(
  message:
    | { text: string; author: string | null | undefined }
    | null
    | undefined,
): BreakMessage | null {
  return message
    ? { text: message.text, author: message.author ?? null }
    : null;
}

// Custom message shown on the intermission screen while a break is active,
// or null for none. Lives in the main process and stays live-synced across
// every renderer/remocon client; set at most once per edit, so commits go
// out immediately (no debounce).
export default function useBreakMessage() {
  const [breakMessage, setLocalBreakMessage] = useState<BreakMessage | null>(
    null,
  );
  const [commit] = useMutation<useBreakMessageMutation>(breakMessageMutation);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        return;
      }

      fetchQuery<useBreakMessageQuery>(
        environment,
        breakMessageQuery,
        {},
      ).subscribe({
        next: (response: useBreakMessageQuery["response"]) =>
          setLocalBreakMessage(normalizeBreakMessage(response.breakMessage)),
      });
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(WS_RECONNECTED_EVENT, handleVisibilityChange);

    const initialQuery = fetchQueryWithRetry<useBreakMessageQuery>(
      environment,
      breakMessageQuery,
      {},
      (response) =>
        setLocalBreakMessage(normalizeBreakMessage(response.breakMessage)),
    );

    const subscription = requestSubscription<useBreakMessageSubscription>(
      environment,
      {
        subscription: breakMessageSubscription,
        variables: {},
        onNext: (response) => {
          if (response)
            setLocalBreakMessage(
              normalizeBreakMessage(response.breakMessageChanged),
            );
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

  const setBreakMessage = (text: string | null, author: string | null) => {
    setLocalBreakMessage(text ? { text, author } : null);
    commit({ variables: { text, author } });
  };

  return { breakMessage, setBreakMessage };
}
