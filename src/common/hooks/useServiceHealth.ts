import { useEffect, useRef, useState } from "react";
import { fetchQuery, graphql, useMutation } from "react-relay";

import environment from "../graphqlEnvironment";
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

// `onTransition` fires whenever reachability flips healthy⇄unhealthy, so a
// surface can announce it (the big screen toasts the room). It's opt-in
// because the renderer bundle runs in two windows and the remocon in as many
// phones as there are guests, and they'd otherwise all announce the same flip.
export default function useServiceHealth({
  onTransition,
}: {
  onTransition?: (health: ServiceHealthState, unhealthy: boolean) => void;
} = {}) {
  const [serviceHealth, setServiceHealth] = useState<ServiceHealthState | null>(
    null,
  );
  const wasUnhealthyRef = useRef(false);
  const [commitRecheck, isRechecking] =
    useMutation<useServiceHealthRecheckMutation>(recheckServiceHealthMutation);

  // A ref so the polling effect below can stay mounted for the component's
  // lifetime without capturing a stale callback.
  const onTransitionRef = useRef(onTransition);
  onTransitionRef.current = onTransition;

  const apply = (fresh: ServiceHealthState) => {
    setServiceHealth(fresh);

    const unhealthy = !fresh.damAvailable || !fresh.joysoundAvailable;
    if (unhealthy === wasUnhealthyRef.current) return;
    wasUnhealthyRef.current = unhealthy;
    onTransitionRef.current?.(fresh, unhealthy);
  };

  useEffect(() => {
    const poll = () =>
      fetchQuery<useServiceHealthQuery>(
        environment,
        serviceHealthQuery,
        {},
      ).subscribe({
        next: ({ serviceHealth: fresh }) => apply(fresh),
      });

    poll();
    const interval = setInterval(poll, SERVICE_HEALTH_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const recheck = () =>
    commitRecheck({
      variables: {},
      onCompleted: ({ recheckServiceHealth }) => apply(recheckServiceHealth),
    });

  return { serviceHealth, isRechecking, recheck };
}
