import { useEffect, useState } from "react";
import { fetchQuery, graphql, useMutation } from "react-relay";

import environment from "../../common/graphqlEnvironment";
import { useServiceHealthQuery } from "./__generated__/useServiceHealthQuery.graphql";
import { useServiceHealthRecheckMutation } from "./__generated__/useServiceHealthRecheckMutation.graphql";

const serviceHealthQuery = graphql`
  query useServiceHealthQuery {
    serviceHealth {
      damAvailable
      joysoundAvailable
      checkedAt
    }
  }
`;

const recheckServiceHealthMutation = graphql`
  mutation useServiceHealthRecheckMutation {
    recheckServiceHealth {
      damAvailable
      joysoundAvailable
      checkedAt
    }
  }
`;

// Match the renderer's cadence: Query.serviceHealth is a cheap local read of
// whatever the main process last computed, so polling it is safe. Only the
// recheck mutation awaits a live check (worth a spinner).
const SERVICE_HEALTH_POLL_INTERVAL_MS = 30 * 1000;

export interface ServiceHealthState {
  damAvailable: boolean;
  joysoundAvailable: boolean;
  checkedAt: string;
}

export default function useServiceHealth() {
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthState | null>(
    null,
  );
  const [commitRecheck, isRechecking] =
    useMutation<useServiceHealthRecheckMutation>(recheckServiceHealthMutation);

  useEffect(() => {
    const poll = () =>
      fetchQuery<useServiceHealthQuery>(
        environment,
        serviceHealthQuery,
        {},
      ).subscribe({
        next: ({ serviceHealth: fresh }) => setServiceHealth(fresh),
      });

    poll();
    const interval = setInterval(poll, SERVICE_HEALTH_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const recheck = () =>
    commitRecheck({
      variables: {},
      onCompleted: ({ recheckServiceHealth }) =>
        setServiceHealth(recheckServiceHealth),
    });

  return { serviceHealth, isRechecking, recheck };
}
