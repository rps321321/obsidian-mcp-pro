// Bounded-concurrency helper for fan-out over a collection of items.
// Each item's result is placed in the output array at its original index.
// Errors are swallowed per-item (onError callback) so one bad read doesn't
// abort the whole scan — callers like tag/link aggregators want partial
// results rather than a hard failure.

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (err: unknown, item: T, index: number) => void,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        onError?.(err, items[i], i);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
