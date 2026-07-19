// rv-gate — bind the runtime BEHAVIOR verdict into the MergeAuthority land decision.
//
// THE GAP THIS CLOSES: behavior verdicts (rv-11/rv-6/rv-16a/rv-19) were persisted but
// NEVER consulted by the land decision — a fix could merge even though its declared
// product behavior failed on the live surface. This reader derives, at LAND time, the
// run's behavior-acceptance outcome and hands it to `authorizeAndLand` as a fail-closed
// pre-authorize signal (mirroring the gate↔land / review↔land TOCTOU guards).
//
// APPLIES-ONLY-WHEN-REQUIRED (never blocks non-behavior runs): the behavior section
// gates ONLY when the merge run has a PRE-MERGE behavior verification (`purpose =
// 'pre_merge'`) that produced at least one BLOCKING, non-quarantined verdict. Most runs
// today produce no such verdict → `not_applicable` → the land is decided on CI alone,
// exactly as before. This mirrors how the native CI gate only applies when CI ran.
//
// FAIL-CLOSED (§0) when it DOES apply: only an actual `passed` outcome on every blocking,
// non-quarantined behavior clears. A decisive product failure (`failed_product` /
// `failed_visual` / `failed_verification_contract`) BLOCKS; an inconclusive/absent/
// still-running verdict BLOCKS (inconclusive ≠ passed — absence of a required verdict must
// NEVER silently authorize).
//
// QUARANTINE (rv-17 semantics, honored here via the per-verdict `flake_state`): a
// `quarantined_fragment` verdict is EXCLUDED-FROM-GREEN — it is neither counted toward the
// pass NOR used to block on flake noise. A rich rv-17 `BehaviorQuarantineReader` (a
// governance table) can later layer over this per-verdict exclusion without changing the
// land-decision seam.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BehaviorVerdictOutcome, FlakeState } from "../contracts/runtimeVerificationAdapters.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

/**
 * The run's behavior-acceptance outcome at land time.
 *   - `not_applicable` — no PRE-MERGE behavior verification with a blocking verdict was
 *     required for this run. The land decides on the other signals alone; NEVER blocks.
 *   - `passed`         — every blocking, non-quarantined behavior recorded `passed`.
 *   - `failed`         — a blocking, non-quarantined behavior recorded a decisive product
 *     failure. Fail-closed: NOT authorized.
 *   - `inconclusive`   — behavior verification was required (a pre_merge run exists) but did
 *     NOT reach a decisive green (still running/failed, or a blocking verdict is
 *     inconclusive). Fail-closed: NOT authorized (inconclusive ≠ passed).
 */
export type BehaviorLandGate =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "passed"; readonly passedBlockingCount: number }
  | { readonly kind: "failed"; readonly behaviorRevisionId: string; readonly outcome: BehaviorVerdictOutcome }
  | { readonly kind: "inconclusive"; readonly reason: string };

/** A completed pre-merge verification run's status, or the reason it is not yet decisive. */
export type BehaviorRunStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

/** One blocking-or-advisory behavior verdict row the evaluator judges. */
export interface BehaviorVerdictRow {
  readonly behaviorRevisionId: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly flakeState: FlakeState;
  readonly gateEffect: "blocking" | "advisory";
}

const DECISIVE_FAILURES: ReadonlySet<BehaviorVerdictOutcome> = new Set<BehaviorVerdictOutcome>([
  "failed_product",
  "failed_visual",
  "failed_verification_contract",
]);

const INCONCLUSIVE_OUTCOMES: ReadonlySet<BehaviorVerdictOutcome> = new Set<BehaviorVerdictOutcome>([
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);

/**
 * PURE: judge the run's behavior-acceptance outcome from the latest pre-merge verification
 * run's status + its verdicts. Kept DB-free so the fail-closed decision table is unit-tested
 * without Postgres — the SQL wrapper below only feeds it rows.
 *
 * `runStatus === undefined` ⇒ NO pre-merge behavior verification exists for the run ⇒
 * `not_applicable` (behavior was never required; the land is unaffected).
 */
export function evaluateBehaviorLandGate(
  runStatus: BehaviorRunStatus | undefined,
  verdicts: readonly BehaviorVerdictRow[],
): BehaviorLandGate {
  // No pre-merge behavior verification run at all ⇒ behavior acceptance was not required.
  if (runStatus === undefined) {
    return { kind: "not_applicable" };
  }
  // A pre-merge verification run exists but has NOT completed ⇒ required-but-not-decided ⇒
  // fail closed. A `failed`/`cancelled` verification run is likewise not a green.
  if (runStatus !== "completed") {
    return {
      kind: "inconclusive",
      reason: `pre-merge behavior verification is '${runStatus}', not a completed pass`,
    };
  }
  // Only BLOCKING, non-quarantined verdicts gate. Advisory verdicts never block; a
  // `quarantined_fragment` verdict is excluded-from-green (not a pass, not a block).
  const blocking = verdicts.filter(
    (verdict) => verdict.gateEffect === "blocking" && verdict.flakeState !== "quarantined_fragment",
  );
  // Nothing enforceable (all advisory / all quarantined / none) ⇒ not_applicable ⇒ never
  // blocks a run whose behaviors do not gate.
  if (blocking.length === 0) {
    return { kind: "not_applicable" };
  }
  // A decisive product failure on any blocking behavior fails closed (most actionable first).
  const failure = blocking.find((verdict) => DECISIVE_FAILURES.has(verdict.outcome));
  if (failure !== undefined) {
    return { kind: "failed", behaviorRevisionId: failure.behaviorRevisionId, outcome: failure.outcome };
  }
  // An inconclusive blocking verdict fails closed — inconclusive is NEVER a pass.
  const inconclusive = blocking.find((verdict) => INCONCLUSIVE_OUTCOMES.has(verdict.outcome));
  if (inconclusive !== undefined) {
    return {
      kind: "inconclusive",
      reason:
        `blocking behavior '${inconclusive.behaviorRevisionId}' recorded '${inconclusive.outcome}' ` +
        `(not a decisive pass)`,
    };
  }
  // Defensive: every remaining blocking verdict must be an explicit `passed`. Any other
  // (unexpected) outcome fails closed rather than silently clearing.
  if (blocking.every((verdict) => verdict.outcome === "passed")) {
    return { kind: "passed", passedBlockingCount: blocking.length };
  }
  const stray = blocking.find((verdict) => verdict.outcome !== "passed");
  return {
    kind: "inconclusive",
    reason: `blocking behavior '${stray?.behaviorRevisionId ?? "unknown"}' has a non-pass outcome '${
      stray?.outcome ?? "unknown"
    }'`,
  };
}

/**
 * Re-read the run's behavior-acceptance outcome FRESH at land time, org-scoped (RLS). Picks
 * the LATEST `pre_merge` behavior verification run bound to the merge run (its `run_id`) and
 * evaluates that run's blocking, non-quarantined verdicts via {@link evaluateBehaviorLandGate}.
 *
 * FAIL-CLOSED reads: a query error propagates (the caller's land already fails closed on a
 * throw). No pre_merge run ⇒ `not_applicable` (behavior was not required for this run).
 */
export async function resolveLandTimeBehaviorGate(
  pool: pg.Pool,
  orgId: string,
  runId: string,
  withOrgScope?: OrgScope,
): Promise<BehaviorLandGate> {
  const scope: OrgScope = withOrgScope ?? ((org, operation) => runWithOrgScope(pool, org, operation));
  return scope(orgId, async (client) => {
    // The latest pre-merge behavior verification run bound to THIS merge run.
    const runRow = (
      await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM behavior_verification_runs
          WHERE org_id = $1 AND run_id = $2 AND purpose = 'pre_merge'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [orgId, runId],
      )
    ).rows[0];
    if (runRow === undefined) {
      return { kind: "not_applicable" };
    }
    const status = decodeRunStatus(runRow.status);
    if (status !== "completed") {
      return evaluateBehaviorLandGate(status, []);
    }
    const verdictRows = (
      await client.query<{
        behavior_revision_id: string;
        outcome: string;
        flake_state: string;
        gate_effect: string;
      }>(
        `SELECT behavior_revision_id, outcome, flake_state, gate_effect
           FROM behavior_verdicts
          WHERE org_id = $1 AND run_id = $2`,
        [orgId, runRow.id],
      )
    ).rows;
    return evaluateBehaviorLandGate(
      status,
      verdictRows.map((row) => decodeVerdictRow(row)),
    );
  });
}

const RUN_STATUSES: ReadonlySet<BehaviorRunStatus> = new Set<BehaviorRunStatus>([
  "planned",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const OUTCOMES: ReadonlySet<BehaviorVerdictOutcome> = new Set<BehaviorVerdictOutcome>([
  "passed",
  "failed_product",
  "failed_verification_contract",
  "failed_visual",
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);
const FLAKE_STATES: ReadonlySet<FlakeState> = new Set<FlakeState>([
  "stable",
  "suspected",
  "confirmed",
  "quarantined_fragment",
]);

function decodeRunStatus(value: string): BehaviorRunStatus {
  if (!RUN_STATUSES.has(value as BehaviorRunStatus)) {
    throw new TypeError(`behavior verification run has an unknown status: ${value}`);
  }
  return value as BehaviorRunStatus;
}

function decodeVerdictRow(row: {
  behavior_revision_id: string;
  outcome: string;
  flake_state: string;
  gate_effect: string;
}): BehaviorVerdictRow {
  if (!OUTCOMES.has(row.outcome as BehaviorVerdictOutcome)) {
    throw new TypeError(`behavior verdict has an unknown outcome: ${row.outcome}`);
  }
  if (!FLAKE_STATES.has(row.flake_state as FlakeState)) {
    throw new TypeError(`behavior verdict has an unknown flake state: ${row.flake_state}`);
  }
  if (row.gate_effect !== "blocking" && row.gate_effect !== "advisory") {
    throw new TypeError(`behavior verdict has an unknown gate effect: ${row.gate_effect}`);
  }
  return {
    behaviorRevisionId: row.behavior_revision_id,
    outcome: row.outcome as BehaviorVerdictOutcome,
    flakeState: row.flake_state as FlakeState,
    gateEffect: row.gate_effect,
  };
}
