import { fetchQuery } from "react-relay";
import { Environment, GraphQLTaggedNode, OperationType } from "relay-runtime";

const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;
// These are all trivial local reads (synced settings), so a healthy response
// arrives in milliseconds. The browser's own fetch timeout is ~5 minutes,
// and a request that hangs instead of erroring (a request landing mid
// server boot, a half-open socket) used to stall the retry loop for that
// whole window, e.g. BGM staying silent for minutes after launch because
// bgmTrack never delivered. Treat a slow attempt as failed and retry.
const ATTEMPT_TIMEOUT_MS = 10000;

// The initial fetch a hook fires on mount can race the GraphQL server coming
// up (dev launches the renderer alongside the server) and the very first
// request after a fresh launch has historically flaked (a Parcel lazy-module
// race, previously aggravated by Sentry's require patching, see CLAUDE.md).
// A plain fetchQuery with no error handler fails silently and the setting
// never syncs, so retry with capped backoff until the query succeeds or the
// hook unmounts.
export default function fetchQueryWithRetry<TQuery extends OperationType>(
  environment: Environment,
  query: GraphQLTaggedNode,
  variables: TQuery["variables"],
  onNext: (response: TQuery["response"]) => void,
): { unsubscribe: () => void } {
  let cancelled = false;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let attemptTimeout: ReturnType<typeof setTimeout> | null = null;
  let subscription: { unsubscribe: () => void } | null = null;

  const attempt = (delayMs: number) => {
    let settled = false;

    const scheduleRetry = () => {
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        attempt(Math.min(delayMs * 2, MAX_RETRY_DELAY_MS));
      }, delayMs);
    };

    attemptTimeout = setTimeout(() => {
      attemptTimeout = null;
      if (cancelled || settled) return;
      settled = true;
      if (subscription) subscription.unsubscribe();
      console.warn(
        `Initial query hung for ${ATTEMPT_TIMEOUT_MS}ms, retrying in ${delayMs}ms`,
      );
      scheduleRetry();
    }, ATTEMPT_TIMEOUT_MS);

    const clearAttemptTimeout = () => {
      if (attemptTimeout !== null) {
        clearTimeout(attemptTimeout);
        attemptTimeout = null;
      }
    };

    subscription = fetchQuery<TQuery>(environment, query, variables).subscribe({
      next: (response: TQuery["response"]) => {
        if (settled) return;
        settled = true;
        clearAttemptTimeout();
        if (!cancelled) onNext(response);
      },
      error: (error: Error) => {
        if (settled) return;
        settled = true;
        clearAttemptTimeout();
        if (cancelled) return;
        console.warn(`Initial query failed, retrying in ${delayMs}ms`, error);
        scheduleRetry();
      },
    });
  };

  attempt(INITIAL_RETRY_DELAY_MS);

  return {
    unsubscribe: () => {
      cancelled = true;
      if (retryTimeout !== null) clearTimeout(retryTimeout);
      if (attemptTimeout !== null) clearTimeout(attemptTimeout);
      if (subscription) subscription.unsubscribe();
    },
  };
}
