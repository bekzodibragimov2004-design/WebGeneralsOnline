/**
 * Concurrency policy for the download pool.
 *
 * Small files are cheap, so many can run at once. A large file already fills the link by itself and
 * holds an exclusive OPFS handle, so only a few large files run together and the remaining slots
 * stay free for small ones. Files are started largest first, which keeps the slowest transfer from
 * ending up alone at the tail.
 */

export const MIB = 1024 * 1024;

export interface PoolLimits {
  maxActive: number;
  maxBigActive: number;
  /** Files at least this big count as "big". */
  bigThreshold: number;
}

export const DEFAULT_LIMITS: PoolLimits = { maxActive: 8, maxBigActive: 3, bigThreshold: 32 * MIB };

export function chooseLimits(sizes: readonly number[], override?: Partial<PoolLimits>): PoolLimits {
  const base = { ...DEFAULT_LIMITS, ...override };
  const big = sizes.filter((size) => size >= base.bigThreshold).length;
  const maxActive = Math.max(1, Math.min(base.maxActive, sizes.length));
  const maxBigActive = Math.max(1, Math.min(base.maxBigActive, maxActive, big || 1));
  return { maxActive, maxBigActive, bigThreshold: base.bigThreshold };
}

/** Largest first; ties keep their original order. */
export function sortForDispatch<T extends { size: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.size - a.item.size || a.index - b.index)
    .map((entry) => entry.item);
}

export interface ActiveCounts {
  total: number;
  big: number;
}

/** Index of the next queued file that may start now, or -1 when none may. */
export function pickNext(queueSizes: readonly number[], active: ActiveCounts, limits: PoolLimits): number {
  if (active.total >= limits.maxActive) return -1;
  for (let i = 0; i < queueSizes.length; i += 1) {
    const isBig = (queueSizes[i] ?? 0) >= limits.bigThreshold;
    if (!isBig || active.big < limits.maxBigActive) return i;
  }
  return -1;
}
