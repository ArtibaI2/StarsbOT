/**
 * Cursor math for the Fragment minter event feed.
 *
 * The feed is read with `after_lt=<cursor>`, so the cursor must only move past
 * events that were fully processed. If enrichment for an event failed, the
 * cursor stops just before the oldest failure and the event is re-read on the
 * next cycle (dedup by craftKey drops anything already handled).
 */
export function nextCraftCursor(
  previous: number | undefined,
  fetchedLts: readonly number[],
  failedLts: readonly number[]
): number | undefined {
  const valid = fetchedLts.filter((lt) => Number.isFinite(lt));
  if (valid.length === 0) return previous;

  const newest = Math.max(...valid);
  const failures = failedLts.filter((lt) => Number.isFinite(lt));

  if (failures.length === 0) {
    return previous === undefined ? newest : Math.max(previous, newest);
  }

  const oldestFailure = Math.min(...failures);
  let boundary: number | undefined;
  for (const lt of valid) {
    if (lt < oldestFailure && (boundary === undefined || lt > boundary)) {
      boundary = lt;
    }
  }

  if (boundary === undefined) return previous;
  return previous === undefined ? boundary : Math.max(previous, boundary);
}
