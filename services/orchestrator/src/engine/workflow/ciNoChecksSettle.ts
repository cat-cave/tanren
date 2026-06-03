// The run-loop NO-CHECKS SETTLE policy (the fix for a no-CI repo hanging the CI gate
// forever). `evaluateCiObservation` (ciPolling.ts) stays PURE — it reports raw truth
// (genuinely-zero checks ⇒ `no_checks` pending). The INTERPRETATION "this repo has NO
// CI registered → after a bounded grace, treat the gate as green" is a POLL POLICY,
// anchored on a STABLE timestamp (the CI task `started_at`, NOT the ephemeral PR head
// sha). Extracted from ciPolling.ts to keep that file under its 500-line cap (a plain
// re-home; behavior unchanged). See DEFAULT_NO_CHECKS_SETTLE_MS for the safety boundary.

import { migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_NO_CHECKS_SETTLE_MS } from "../config/shared.js";
import type { CiObservation } from "./ciPolling.js";

/**
 * The run-loop NO-CHECKS SETTLE (poll policy — `evaluateCiObservation` stays pure). A
 * GENUINELY-zero-checks observation (`no_checks`) is PROMOTED pending→passed once the
 * no-checks grace has elapsed against the STABLE CI task `started_at`. Everything else
 * is returned UNCHANGED:
 *   - `checks_pending` (real CI registered, not yet done) → unchanged (WAIT for it; a
 *     repo with real CI flips no_checks→checks_pending within seconds, before the grace,
 *     so the settle never short-circuits a repo that has CI);
 *   - `check_failed`/`failed` → unchanged (a red check ALWAYS blocks — never settled);
 *   - `all_checks_passed` (the Mergify-present fast path) → unchanged (already passed).
 * Pure + side-effect-free so it is unit-testable with an injected clock.
 */
export function settleNoChecksObservation(
  observation: CiObservation,
  startedAtMs: number,
  noChecksSettleMs: number,
  nowMs: number,
): CiObservation {
  if (observation.reason !== "no_checks") {
    return observation;
  }
  const elapsed = nowMs - startedAtMs;
  if (elapsed < noChecksSettleMs) {
    return observation;
  }
  // The repo has NO CI registered + the grace elapsed: nothing to verify → green
  // (mirror GitHub merging a PR with no required checks + no failing checks).
  return { ...observation, status: "passed", reason: "no_checks_settled" };
}

/**
 * Resolve the per-project no-checks settle grace (ms) from `projects.config` — falling
 * back to the schema default if the config cannot be parsed (a legacy versionless blob
 * or a partial config), never a hard error in the poll hot path.
 */
export function resolveNoChecksSettleMs(projectConfig: Record<string, unknown>): number {
  try {
    return migrateProjectConfig(projectConfig).noChecksSettleMs;
  } catch {
    return DEFAULT_NO_CHECKS_SETTLE_MS;
  }
}

/** Coerce a pg timestamp (Date | ISO string | null) to ms epoch, or undefined. */
export function timestampToMs(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
