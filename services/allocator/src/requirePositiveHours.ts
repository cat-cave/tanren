/**
 * Parse a positive-hours env var fail-closed (the reap-everything guard).
 *
 * `TANREN_MAX_RUN_HOURS` becomes the sweeper's abandoned threshold (`now -
 * hours`). A `0` would make the threshold exactly `now`, so
 * `listActiveOlderThan(now)` reaps EVERY active runner — including the live apex
 * run; `abc` → NaN → an Invalid Date threshold. A reaper threshold must NEVER be
 * `<= now`, so we reject any non-finite or `<= 0` value, fall back to the default
 * with a LOUD `console.error` (no silent degrade), and only accept a strictly
 * positive, finite number.
 *
 * Self-contained on purpose: the seed of a future env-schema, not a dependency.
 * Lives in its own module (like `requireEnv.ts`) so it is importable for tests
 * without triggering `main.ts`'s module-level env reads.
 */
export function requirePositiveHours(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[allocator] ${name}=${JSON.stringify(raw)} is not a positive number; falling back to ${fallback}h. ` +
        `A reaper threshold must never be <= now (that would reap every active runner).`,
    );
    return fallback;
  }
  return parsed;
}
