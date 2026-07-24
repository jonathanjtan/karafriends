import { useEffect, useState } from "react";
import { fetchQuery, graphql, requestSubscription } from "react-relay";

import environment, {
  WS_RECONNECTED_EVENT,
} from "../../common/graphqlEnvironment";
import fetchQueryWithRetry from "../../common/hooks/fetchQueryWithRetry";
import { usePeopleQuery } from "./__generated__/usePeopleQuery.graphql";
import { usePeopleSubscription } from "./__generated__/usePeopleSubscription.graphql";

// Taken straight off the generated query rather than hand-declared, so the
// nullability matches what Relay actually hands back.
export type PersonSummary = usePeopleQuery["response"]["people"][number];

const peopleQuery = graphql`
  query usePeopleQuery {
    people {
      personId
      displayName
      profilePictureUrl
      profilePictureFrame
      lastSeenAt
    }
  }
`;

const peopleSubscription = graphql`
  subscription usePeopleSubscription {
    peopleChanged {
      personId
      displayName
      profilePictureUrl
      profilePictureFrame
      lastSeenAt
    }
  }
`;

// The singer registry, newest-seen first. Subscribed rather than fetched once
// so a gate left open on one phone picks up someone joining on another.
export default function usePeople() {
  const [people, setPeople] = useState<readonly PersonSummary[] | null>(null);

  useEffect(() => {
    function refetch() {
      if (document.hidden) return;

      fetchQuery<usePeopleQuery>(environment, peopleQuery, {}).subscribe({
        next: (response: usePeopleQuery["response"]) =>
          setPeople(response.people),
      });
    }

    document.addEventListener("visibilitychange", refetch);
    window.addEventListener(WS_RECONNECTED_EVENT, refetch);

    const initialQuery = fetchQueryWithRetry<usePeopleQuery>(
      environment,
      peopleQuery,
      {},
      (response) => setPeople(response.people),
    );

    const subscription = requestSubscription<usePeopleSubscription>(
      environment,
      {
        subscription: peopleSubscription,
        variables: {},
        onNext: (response) => {
          if (response) setPeople(response.peopleChanged);
        },
      },
    );

    return () => {
      document.removeEventListener("visibilitychange", refetch);
      window.removeEventListener(WS_RECONNECTED_EVENT, refetch);

      initialQuery.unsubscribe();
      subscription.dispose();
    };
  }, []);

  return people;
}
