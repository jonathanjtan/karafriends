// Runs `fn` over `items` with at most `concurrency` calls in flight at once,
// preserving input order in the result array. Semantics mirror Promise.all:
// the first rejection from `fn` rejects the whole call, and results for
// items still in flight are discarded.
//
// A caller that instead wants Promise.allSettled semantics (every item runs
// to completion, failures reported per item) gets that by having `fn` catch
// its own errors and resolve with a PromiseSettledResult-shaped value;
// concurrency limiting is orthogonal to whether individual failures are
// tolerated, so one implementation covers both callers.
export default async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  fn: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
