import { fetchQuery } from "react-relay";
import { Environment, GraphQLTaggedNode, OperationType } from "relay-runtime";

const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;

// The initial fetch a hook fires on mount can race the GraphQL server coming
// up (dev launches the renderer alongside the server) and the very first
// request after a fresh launch is known to flake (the Sentry
// require-in-the-middle / Parcel race — see CLAUDE.md). A plain fetchQuery
// with no error handler fails silently and the setting never syncs, so
// retry with capped backoff until the query succeeds or the hook unmounts.
export default function fetchQueryWithRetry<TQuery extends OperationType>(
  environment: Environment,
  query: GraphQLTaggedNode,
  variables: TQuery["variables"],
  onNext: (response: TQuery["response"]) => void,
): { unsubscribe: () => void } {
  let cancelled = false;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let subscription: { unsubscribe: () => void } | null = null;

  const attempt = (delayMs: number) => {
    subscription = fetchQuery<TQuery>(environment, query, variables).subscribe({
      next: (response: TQuery["response"]) => {
        if (!cancelled) onNext(response);
      },
      error: (error: Error) => {
        if (cancelled) return;
        console.warn(`Initial query failed, retrying in ${delayMs}ms`, error);
        retryTimeout = setTimeout(() => {
          retryTimeout = null;
          attempt(Math.min(delayMs * 2, MAX_RETRY_DELAY_MS));
        }, delayMs);
      },
    });
  };

  attempt(INITIAL_RETRY_DELAY_MS);

  return {
    unsubscribe: () => {
      cancelled = true;
      if (retryTimeout !== null) clearTimeout(retryTimeout);
      if (subscription) subscription.unsubscribe();
    },
  };
}
