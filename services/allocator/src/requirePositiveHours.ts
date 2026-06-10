/**
 * Parse a positive-hours env var fail-closed (the reap-everything guard).
 *
 * `TANREN_MAX_RUN_HOURS` becomes the sweeper's abandoned threshold (`now -
 * hours`). A `0` would make the threshold exactly `now`, so
 * `listActiveOlderThan(now)` reaps EVERY active runner — including the live apex
 * run; `abc` → NaN → an Invalid Date threshold. A reaper threshold must NEVER be
 * `<= now`, so we reject any non-finite or `<= 0` value, fall back to the default
 * with a LOUD structured error log (no silent degrade), and only accept a strictly
 * positive, finite number.
 *
 * Imports only the dependency-free logger (no module-level env reads), so it stays
 * importable for tests without triggering `main.ts`'s env reads.
 */
import { createLogger } from "./logger.js";

const log = createLogger("allocator");

export function requirePositiveHours(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.error(
      "env var is not a positive number; falling back to the default. A reaper threshold must never be <= now " +
        "(that would reap every active runner).",
      { name, raw: JSON.stringify(raw), fallbackHours: fallback },
    );
    return fallback;
  }
  return parsed;
}
