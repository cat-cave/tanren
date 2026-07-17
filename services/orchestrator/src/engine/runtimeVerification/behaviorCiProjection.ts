// rv-20 — `ci_test_results` compatibility PROJECTION for behavior verification.
//
// The first-class RBV tables (`behavior_verification_attempts` / `behavior_verdicts`,
// migration 0037, written through `RuntimeVerificationRepository.recordAttempt`) are the
// AUTHORITATIVE record of every behavior-verification attempt. This module projects each
// recorded attempt into the pre-existing generic `ci_test_results` table so that generic
// CI analytics/exports (flaky detection, per-test history, dashboards) stop reading
// `ci_test_results=0` for a project that only ever runs native behavior verification.
//
// PROJECTION, NOT AUTHORITY:
//   - It has NO gate authority. The verdict/gate decision lives entirely in the RBV
//     tables + `MergeAuthority`; a `ci_test_results` row is a read-model shadow only.
//   - It emits NO event. Unlike the JUnit path (`ingestJunitResults`, which appends
//     `ci.tests.reported`), a projection introduces no new fact — so there is nothing to
//     append. The rows are visible through the existing `ci_test_results` reads/exports.
//   - It is a faithful shadow: it projects exactly the attempts it is handed and never
//     synthesizes a green row for an unexercised behavior (see the outcome mapping —
//     inconclusive/superseded attempts never become `passed`).
//
// PLANE-SPLIT: `ci_test_results` is a DATA-PLANE table (the de-privileged
// `tanren_dataplane` role keeps full write on it), so — exactly like `ingestJunitResults`
// (`../ci/junitIngest.ts`, the reference INSERT shape this reuses) — the per-attempt
// INSERT runs directly on the org-scoped `client`. No `EventStore` is involved.
//
// Append-only: each recorded attempt inserts one row. It never updates — per-test HISTORY
// (the fail-then-pass sequence flaky detection consumes) is the asset.

import { randomUUID } from "node:crypto";
import type { QueryClient } from "../data/orgScopedDb.js";
import type { BehaviorVerdictOutcome } from "../contracts/runtimeVerification.js";

/** The org/project scope the projection INSERT is written under (RLS-checked). */
export interface BehaviorCiProjectionScope {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * One behavior-verification attempt, plus the run-level context needed to satisfy the
 * `ci_test_results` column contract. The identity fields (`behaviorRevisionId`,
 * `exampleHash`, `matrixHash`) are the composite key of the projected `test_id`; the run
 * context (`workflowRunId`, `headSha`) is lifted from the owning
 * `behavior_verification_runs` row (its nullable `run_id` FK → `runs.run_id`, and its
 * `prepared_head_sha`).
 */
export interface BehaviorAttemptProjectionInput {
  readonly behaviorRevisionId: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
  readonly outcome: BehaviorVerdictOutcome;
  /**
   * The workflow run this attempt belongs to — the owning verification run's `run_id`
   * (which references `runs.run_id`, the FK `ci_test_results.run_id` also targets). A
   * verification run with no workflow `run_id` cannot be projected (there is no valid
   * run to attribute the compatibility row to); such attempts are skipped upstream.
   */
  readonly workflowRunId: string;
  /** The prepared head SHA the attempt ran against (`behavior_verification_runs.prepared_head_sha`). */
  readonly headSha: string;
  /**
   * The attempt ordinal for this (behavior, example, matrix) within the run, ≥ 1. Distinct
   * attempts/replays of the same behavior case MUST carry distinct ordinals so the
   * fail-then-pass sequence is preserved for same-run flaky detection.
   */
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/**
 * The composite per-test identity a projected attempt lands under:
 *   `behavior:<behaviorRevision>:<exampleHash>:<matrixHash>`
 * This is the cross-run history join key `ci_test_results.test_id` consumers group on.
 */
export function behaviorAttemptTestId(input: {
  readonly behaviorRevisionId: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
}): string {
  return `behavior:${input.behaviorRevisionId}:${input.exampleHash}:${input.matrixHash}`;
}

/** The stable `suite` grouping all behavior projections share, so analytics can filter them out of / into JUnit history. */
export const BEHAVIOR_CI_SUITE = "behavior";

/**
 * Map an RBV attempt outcome onto the `ci_test_results_outcome_check`
 * (`passed|failed|error|skipped`) vocabulary.
 *
 * Honest projection — the key invariant: only a genuinely `passed` attempt yields a
 * `passed` row. An unexercisable behavior (infrastructure/external inconclusive) is an
 * `error`, and a superseded/cancelled attempt is `skipped`; neither is a green row.
 */
export function mapBehaviorOutcomeToCiOutcome(
  outcome: BehaviorVerdictOutcome,
): "passed" | "failed" | "error" | "skipped" {
  switch (outcome) {
    case "passed":
      return "passed";
    case "failed_product":
    case "failed_verification_contract":
    case "failed_visual":
      return "failed";
    case "inconclusive_infrastructure":
    case "inconclusive_external":
      return "error";
    case "cancelled_superseded":
      return "skipped";
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled behavior verdict outcome: ${String(unreachable)}`);
    }
  }
}

/** Wall-clock ms from the attempt window, or null when it never finished. */
function attemptDurationMs(input: BehaviorAttemptProjectionInput): number | null {
  if (input.finishedAt === undefined) return null;
  const ms = new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : null;
}

/** What a single projected row landed as (returned for the caller's evidence/assertions). */
export interface ProjectedBehaviorRow {
  readonly testId: string;
  readonly outcome: "passed" | "failed" | "error" | "skipped";
}

/**
 * Project ONE recorded behavior-verification attempt into `ci_test_results`, reusing the
 * exact column contract of `ingestJunitResults`
 * (`id, project_id, org_id, test_id, file, suite, head_sha, run_id, attempt, outcome,
 * duration_ms, retries, observed_at`).
 *
 * MUST be called inside the attempt's org scope — the passed `client` is the org-scoped
 * data-plane client, so the INSERT is RLS-checked against the run's org.
 */
export async function projectBehaviorAttemptToCiTestResult(
  client: QueryClient,
  scope: BehaviorCiProjectionScope,
  input: BehaviorAttemptProjectionInput,
): Promise<ProjectedBehaviorRow> {
  const testId = behaviorAttemptTestId(input);
  const outcome = mapBehaviorOutcomeToCiOutcome(input.outcome);
  await client.query(
    `INSERT INTO ci_test_results
       (id, project_id, org_id, test_id, file, suite, head_sha, run_id, attempt, outcome, duration_ms, retries, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    [
      randomUUID(),
      scope.projectId,
      scope.orgId,
      testId,
      // A behavior has no single source file; the executable fragments are the source, and
      // the identity already carries the behavior revision. Leave `file` null rather than
      // fabricate a path.
      null,
      BEHAVIOR_CI_SUITE,
      input.headSha,
      input.workflowRunId,
      input.attempt,
      outcome,
      attemptDurationMs(input),
      // Intra-attempt reruns do not exist at the projection grain — each RBV attempt is one
      // row; replays are distinct attempts with their own ordinal.
      0,
    ],
  );
  return { testId, outcome };
}

/** Result of projecting a batch of attempts (an entire run's executed attempts). */
export interface BehaviorCiProjectionResult {
  /** Rows inserted — exactly `inputs.length` (N executed attempts ⇒ N rows; zero ⇒ zero). */
  readonly inserted: number;
  readonly rows: readonly ProjectedBehaviorRow[];
}

/**
 * Project every executed attempt of a run into `ci_test_results`. A run with N executed
 * attempts yields N rows; a run with zero executed attempts (the negative control) inserts
 * ZERO rows — no fabricated green row is ever synthesized.
 */
export async function projectBehaviorAttempts(
  client: QueryClient,
  scope: BehaviorCiProjectionScope,
  inputs: readonly BehaviorAttemptProjectionInput[],
): Promise<BehaviorCiProjectionResult> {
  const rows: ProjectedBehaviorRow[] = [];
  for (const input of inputs) {
    rows.push(await projectBehaviorAttemptToCiTestResult(client, scope, input));
  }
  return { inserted: rows.length, rows };
}
