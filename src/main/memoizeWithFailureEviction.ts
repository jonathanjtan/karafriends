// lodash memoize caches rejected promises forever, so one failed login (e.g.
// win10.clubdam.com geo-blocking a non-Japan IP) would keep the service
// broken until relaunch even after the user fixes their network. This
// variant evicts the cached promise on rejection (same pattern as
// joysoundApi's songDetailCache) so the next request retries. Rejections
// still propagate to callers, which must .catch() them per the main-process
// rule; concurrent callers share the single in-flight promise.
//
// reset() drops a cached *success* too, so the next call re-runs fn from
// scratch — used by the manual "check now" health check to recover from
// stale-but-cached state (e.g. an expired auth token). In-flight callers
// keep the promise they already hold.
export default function memoizeWithFailureEviction<T>(
  fn: () => Promise<T>,
): (() => Promise<T>) & { reset: () => void } {
  let cached: Promise<T> | null = null;
  const memoized = () => {
    if (cached === null) {
      const promise = fn().catch((error) => {
        if (cached === promise) {
          cached = null;
        }
        throw error;
      });
      cached = promise;
    }
    return cached;
  };
  memoized.reset = () => {
    cached = null;
  };
  return memoized;
}
