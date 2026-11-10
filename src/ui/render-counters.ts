/**
 * Deterministic paint-cache counters (tests/diagnostics only).
 *
 * The block caches skip composing a cache key while every key input is known to
 * be stable, which is the whole point of the fast path — so "the repaint was
 * cheap" cannot be observed from the wall clock in a test. Each block module
 * counts one `countCacheKeyBuild()` immediately before it composes a key, and
 * tests assert exact deltas instead of timings.
 *
 * This is not a debug UI, not a public metric and not a renderer input: nothing
 * in `src/` reads it back.
 */
let keyBuilds = 0

/** Record one composed cache key (called by the block caches only). */
export function countCacheKeyBuild(): void {
  keyBuilds += 1
}

/** Cache keys composed since the last {@link resetCacheKeyBuilds}. */
export function cacheKeyBuilds(): number {
  return keyBuilds
}

/** Reset the counter (tests pin a delta from a known baseline). */
export function resetCacheKeyBuilds(): void {
  keyBuilds = 0
}