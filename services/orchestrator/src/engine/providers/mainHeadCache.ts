// apex-v35 VOLUME guard: a SHORT-TTL single-flight cache for the default-branch (`main`)
// head-sha read.
//
// The batch check (`fetchRef`), percolation/base-shift, and the post-merge watcher ALL
// re-read the SAME `main` head independently and often (every coordinator pass + every
// dependent's percolation + every post-merge wake). On a long heavy-volume build that
// redundant fan-out of identical reads is what PROVOKES GitHub's secondary rate limit —
// which then 403s the very reads, and the engine re-drives, re-reading `main` again. This
// cache collapses the duplicate reads within a short window (and single-flights concurrent
// reads) so a burst of N callers makes ONE GitHub call, not N.
//
// CORRECTNESS: a merge decision must NEVER use a stale base. Two guards keep that true:
//   1. the TTL is SHORT (seconds) — a head moves rarely relative to the read fan-out;
//   2. the cache is BUSTED on `merge.completed` (the head moved) via `invalidate`.
// And the authoritative safety net is unchanged: `landAuthorizedRef` is a compare-and-swap
// that reads the head FRESH (uncached) and rejects loudly on a mismatch — so even a stale
// cached read can never land onto the wrong base.

/** Default head-sha cache TTL. Short enough that a moved head is re-read within seconds. */
export const MAIN_HEAD_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  /** `undefined` is a real cached value: the branch ref is absent (a 404). */
  sha: string | undefined;
  expiresAt: number;
}

interface InflightEntry {
  readonly generation: number;
  readonly promise: Promise<string | undefined>;
}

/**
 * A process-local TTL + single-flight cache for default-branch head reads, keyed by
 * `owner/name/branch`. One shared instance (`sharedMainHeadCache`) backs the live host so
 * the batch/percolation/post-merge readers in one process share it; tests construct a fresh
 * instance for isolation. Cross-process correctness rides on the short TTL + the
 * `landAuthorizedRef` CAS, not on this cache.
 */
export class MainHeadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? MAIN_HEAD_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return the cached head for `key` if still fresh, else run `read` (single-flighting
   * concurrent misses) and cache the result for the TTL. A `read` that throws is NOT
   * cached and propagates (a 403/transient must not be memoized).
   */
  async read(key: string, read: () => Promise<string | undefined>): Promise<string | undefined> {
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.sha;
    }
    const generation = this.generations.get(key) ?? 0;
    this.generations.set(key, generation);
    const existing = this.inflight.get(key);
    if (existing !== undefined && existing.generation === generation) {
      return existing.promise;
    }
    // Register the flight before invoking the reader. Besides making the
    // single-flight boundary explicit, this covers a reentrant invalidation
    // triggered synchronously by a reader: invalidate() must see and fence it.
    const promise = Promise.resolve()
      .then(read)
      .then((sha) => {
        // An invalidation that happened while the read was in flight starts a
        // newer generation; the stale result must never repopulate its cache.
        if (this.generations.get(key) === generation) {
          this.entries.set(key, { sha, expiresAt: this.now() + this.ttlMs });
        }
        return sha;
      })
      .finally(() => {
        // An older flight may settle after a newer generation has started;
        // never let its finalizer delete the newer flight's record.
        if (this.inflight.get(key)?.promise === promise) {
          this.inflight.delete(key);
        }
        // Once the flight settles, a generation with no entry or flight has
        // no stale observer left that could reuse it, so reclaim its metadata.
        if (!this.entries.has(key) && !this.inflight.has(key)) {
          this.generations.delete(key);
        }
      });
    this.inflight.set(key, { generation, promise });
    return promise;
  }

  /** Bust the cached head for `key` (call when a merge to that branch completes). */
  invalidate(key: string): void {
    this.entries.delete(key);
    if (this.inflight.has(key)) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    } else {
      this.generations.delete(key);
    }
  }

  /** Bust every cached head (a coarse reset; used by tests). */
  clear(): void {
    for (const key of new Set([...this.entries.keys(), ...this.inflight.keys(), ...this.generations.keys()])) {
      this.invalidate(key);
    }
  }
}

/** Compose the cache key for a repo + branch. */
export function mainHeadCacheKey(owner: string, name: string, branch: string): string {
  return `${owner}/${name}#${branch}`;
}

/** The process-shared cache the live `GitHubCodeHost` uses by default. */
export const sharedMainHeadCache = new MainHeadCache();
