/**
 * rv-10 runs/attempts/verdicts lifecycle — the consumer layer that makes every
 * per-behavior verdict TRACEABLE to the real attempt + run that produced it.
 *
 * The spine (verdictStore.ts) records a RUN and per-behavior VERDICTs plus the
 * verdict's own count tallies (behavior_verdict_attempts / _assertions, 0089).
 * What it never materialized was the REAL attempt row — the 0037
 * `behavior_verification_attempts` a run's attempts live in, the referent
 * `verification_artifacts.producing_attempt_id` FKs to. Without it a verdict has
 * no attempt to trace to and every captured artifact's producing attempt is NULL.
 *
 * This module closes that: it materializes the attempt's `behavior_verification_plans`
 * referent (the attempt.plan_id FK target the acceptance path never persisted),
 * records the real attempt, and — before a verdict seals — FAILS CLOSED unless a
 * complete lifecycle backs it:
 *   - the named producing attempt exists under (org, run) — else {@link OrphanVerdictError};
 *   - that attempt shares the verdict's (behavior, example, matrix) key — else
 *     {@link VerdictAttemptTraceabilityError} (a verdict can never borrow another
 *     behavior's attempt);
 *   - the count of real attempt rows for the verdict's natural key equals the
 *     verdict's attempt_count — else {@link VerdictAttemptCountMismatchError}.
 *
 * All queries run on the caller's org-scoped, RLS-forced client, so a cross-org
 * attempt is invisible (a foreign attempt reads as absent → fail closed).
 */

import type pg from "pg";
import type { CanonicalBody } from "../../contracts/cas.js";
import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type CiCompatibilityOutcome = "passed" | "failed" | "error" | "skipped";

/** Raised when an attempt's append-only CI projection already exists with different facts. */
export class CiCompatibilityProjectionConflictError extends Error {
  public override readonly name = "CiCompatibilityProjectionConflictError";
  public constructor(attemptId: string) {
    super(`CI compatibility projection for behavior attempt ${attemptId} conflicts with immutable history`);
  }
}

/** Raised when a verdict names a producing attempt that does not exist in its run. */
export class OrphanVerdictError extends Error {
  public override readonly name = "OrphanVerdictError";
  public constructor(orgId: string, runId: string, producingAttemptId: string) {
    super(
      `verdict for run ${runId} names producing attempt ${producingAttemptId} that has no real attempt row (org ${orgId})`,
    );
  }
}

/** Raised when the named producing attempt belongs to a different behavior/example/matrix. */
export class VerdictAttemptTraceabilityError extends Error {
  public override readonly name = "VerdictAttemptTraceabilityError";
  public constructor(producingAttemptId: string, detail: string) {
    super(`producing attempt ${producingAttemptId} is not traceable to this verdict: ${detail}`);
  }
}

/** Raised when the real attempt-row count disagrees with the verdict's attempt_count. */
export class VerdictAttemptCountMismatchError extends Error {
  public override readonly name = "VerdictAttemptCountMismatchError";
  public constructor(runId: string, expected: number, actual: number) {
    super(`verdict for run ${runId} claims attempt_count=${expected} but ${actual} real attempt rows back it`);
  }
}

/**
 * Raised when a verdict declares itself {@link VerdictAttemptTrace attemptless} yet the run
 * actually has real attempt rows for the verdict's natural key. An attemptless claim can never
 * mask a run that DID attempt the behavior — that would be the untraceable-verdict fail-open.
 */
export class AttemptlessVerdictHasAttemptsError extends Error {
  public override readonly name = "AttemptlessVerdictHasAttemptsError";
  public constructor(runId: string, actual: number) {
    super(`verdict for run ${runId} claims to be attemptless but ${actual} real attempt row(s) back its natural key`);
  }
}

/**
 * How a verdict traces to the runs/attempts lifecycle. MANDATORY + EXPLICIT — there is no silent
 * "skip the check" path (the old optional `producingAttemptId?: undefined` fail-open). The live
 * acceptance orchestrator always uses `attempted`. `attemptless` is the justified, self-verifying
 * escape hatch for a verdict recorded with genuinely NO execution attempt; {@link assertVerdictTraceable}
 * fails it closed unless ZERO real attempt rows exist for the verdict's natural key.
 */
export type VerdictAttemptTrace =
  | { readonly kind: "attempted"; readonly producingAttemptId: string }
  | { readonly kind: "attemptless" };

/** Idempotent materialization of the attempt's plan referent (attempt.plan_id FK target). */
export interface EnsureVerificationPlanInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly behaviorRevisionId: string;
  /**
   * Must satisfy the `^sha256:[0-9a-f]{64}$` DB CHECK. Do NOT assume the planId is sha256-formatted
   * (it is not on the live orchestrator path); DERIVE this by content-hashing the canonical plan JSON.
   */
  readonly planHash: string;
  readonly planJson: CanonicalBody;
  readonly compilerVersion?: string;
  readonly designContractId?: string;
  readonly provenance?: CanonicalBody;
}

/** One real execution attempt of a behavior's plan within a run. */
export interface RecordAttemptInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly behaviorRevisionId: string;
  readonly planId: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
  readonly shard: number;
  readonly seed: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly classification: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly replayOf?: string;
  readonly failureSignature?: string;
  readonly artifactManifestDigest?: string;
}

/** The verdict→attempt traceability facts asserted fail-closed before a verdict seals. */
export interface VerdictTraceabilityInput {
  readonly orgId: string;
  readonly runId: string;
  readonly behaviorRevisionId: string;
  readonly exampleHash: string;
  readonly matrixHash: string;
  readonly attemptCount: number;
  /** MANDATORY discriminated trace; there is no undefined/skip mode. */
  readonly trace: VerdictAttemptTrace;
}

/** Insert the plan referent if absent (idempotent); the attempt FK then resolves. */
export async function ensureVerificationPlanRow(
  client: QueryClient,
  input: EnsureVerificationPlanInput,
): Promise<string> {
  await client.query(
    `INSERT INTO behavior_verification_plans
       (org_id, id, project_id, behavior_revision_id, design_contract_id, compiler_version,
        plan_hash, status, plan_json, unresolved_capabilities, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'compiled', $8::jsonb, '[]'::jsonb, $9::jsonb)
     ON CONFLICT (org_id, id) DO NOTHING`,
    [
      input.orgId,
      input.planId,
      input.projectId,
      input.behaviorRevisionId,
      input.designContractId ?? null,
      input.compilerVersion ?? "rv-2.plan.v1",
      input.planHash,
      JSON.stringify(input.planJson),
      JSON.stringify(input.provenance ?? { source: "acceptance_orchestrator" }),
    ],
  );
  return input.planId;
}

/** Record one real attempt row (run + plan + behavior referents FK-enforced). */
export async function recordAttemptRow(client: QueryClient, id: string, input: RecordAttemptInput): Promise<string> {
  validateAttemptInput(id, input);
  await client.query(
    `INSERT INTO behavior_verification_attempts
       (org_id, id, project_id, run_id, behavior_revision_id, plan_id, example_hash, matrix_hash,
        shard, seed, replay_of, outcome, classification, started_at, finished_at,
        failure_signature, artifact_manifest_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      input.orgId,
      id,
      input.projectId,
      input.runId,
      input.behaviorRevisionId,
      input.planId,
      input.exampleHash,
      input.matrixHash,
      input.shard,
      input.seed,
      input.replayOf ?? null,
      input.outcome,
      input.classification,
      input.startedAt,
      input.finishedAt ?? null,
      input.failureSignature ?? null,
      input.artifactManifestDigest ?? null,
    ],
  );
  await writeCiCompatibilityProjection(client, id, input);
  return id;
}

/**
 * Append the behavior attempt's CI-reader compatibility row. The insert selects the just-persisted
 * attempt and its owning behavior run, so `head_sha`, optional workflow `run_id`, timestamps, and
 * both direct referents all come from one exact database coordinate. A replay is accepted only
 * when every immutable projected field still matches; a conflicting retry throws and the caller's
 * org-scoped transaction rolls back instead of overwriting history.
 */
export async function writeCiCompatibilityProjection(
  client: QueryClient,
  attemptId: string,
  input: RecordAttemptInput,
): Promise<void> {
  validateAttemptInput(attemptId, input);
  const outcome = normalizeAttemptForCi(input.outcome);
  const projectionId = `behavior:${input.orgId}:${attemptId}`;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ci_test_results
       (id, project_id, org_id, test_id, file, suite, head_sha, source_kind, run_id,
        behavior_verification_run_id, behavior_attempt_id, attempt, outcome, duration_ms,
        retries, observed_at)
     SELECT $1, a.project_id, a.org_id,
            'behavior:' || a.behavior_revision_id || ':' || a.example_hash || ':' || a.matrix_hash,
            NULL, 'runtime-behavior', r.prepared_head_sha, 'behavior_verification', r.run_id,
            r.id, a.id, 1, $4,
            CASE WHEN a.finished_at IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM (a.finished_at - a.started_at)) * 1000)::integer END,
            0, coalesce(a.finished_at, a.started_at)
       FROM behavior_verification_attempts a
       JOIN behavior_verification_runs r
         ON r.org_id = a.org_id AND r.project_id = a.project_id AND r.id = a.run_id
      WHERE a.org_id = $2 AND a.id = $3 AND a.project_id = $5
     ON CONFLICT (org_id, behavior_attempt_id)
       WHERE source_kind = 'behavior_verification'
     DO NOTHING
     RETURNING id`,
    [projectionId, input.orgId, attemptId, outcome, input.projectId],
  );
  if ((inserted.rowCount ?? 0) === 1) return;

  const replay = await client.query<{ matches: unknown }>(
    `SELECT c.id = $1
            AND c.project_id = a.project_id
            AND c.test_id = 'behavior:' || a.behavior_revision_id || ':' || a.example_hash || ':' || a.matrix_hash
            AND c.file IS NULL AND c.suite = 'runtime-behavior'
            AND c.head_sha = r.prepared_head_sha AND c.source_kind = 'behavior_verification'
            AND c.run_id IS NOT DISTINCT FROM r.run_id
            AND c.behavior_verification_run_id = r.id AND c.behavior_attempt_id = a.id
            AND c.attempt = 1 AND c.outcome = $4
            AND c.duration_ms IS NOT DISTINCT FROM
                CASE WHEN a.finished_at IS NULL THEN NULL
                     ELSE floor(extract(epoch FROM (a.finished_at - a.started_at)) * 1000)::integer END
            AND c.retries = 0
            AND c.observed_at = coalesce(a.finished_at, a.started_at) AS matches
       FROM behavior_verification_attempts a
       JOIN behavior_verification_runs r
         ON r.org_id = a.org_id AND r.project_id = a.project_id AND r.id = a.run_id
       JOIN ci_test_results c
         ON c.org_id = a.org_id AND c.behavior_attempt_id = a.id
        AND c.source_kind = 'behavior_verification'
      WHERE a.org_id = $2 AND a.id = $3 AND a.project_id = $5`,
    [projectionId, input.orgId, attemptId, outcome, input.projectId],
  );
  const row = replay.rows[0];
  if (row === undefined) {
    throw new Error(`CI compatibility projection for behavior attempt ${attemptId} has no exact owning run referent`);
  }
  if (row.matches !== true) throw new CiCompatibilityProjectionConflictError(attemptId);
}

/** Exhaustive behavior-verdict → CI-reader outcome normalization. */
export function normalizeAttemptForCi(outcome: BehaviorVerdictOutcome): CiCompatibilityOutcome {
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
      const exhaustive: never = outcome;
      throw new TypeError(`unknown behavior verdict outcome: ${String(exhaustive)}`);
    }
  }
}

function validateAttemptInput(attemptId: string, input: RecordAttemptInput): void {
  for (const [name, value] of [
    ["attemptId", attemptId],
    ["orgId", input.orgId],
    ["projectId", input.projectId],
    ["runId", input.runId],
    ["behaviorRevisionId", input.behaviorRevisionId],
    ["planId", input.planId],
    ["exampleHash", input.exampleHash],
    ["matrixHash", input.matrixHash],
    ["seed", input.seed],
    ["classification", input.classification],
  ] as const) {
    if (value.trim().length === 0) throw new TypeError(`${name} must be a non-blank string`);
  }
  if (!Number.isInteger(input.shard) || input.shard < 0) throw new TypeError("shard must be a non-negative integer");
  const started = timestampMillis(input.startedAt, "startedAt");
  if (input.finishedAt !== undefined) {
    const finished = timestampMillis(input.finishedAt, "finishedAt");
    if (finished < started) throw new TypeError("finishedAt must not precede startedAt");
  }
  normalizeAttemptForCi(input.outcome);
}

function timestampMillis(value: string, name: string): number {
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-blank timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return parsed;
}

/**
 * Fail-closed verdict→attempt→run traceability, driven by the MANDATORY discriminated
 * {@link VerdictAttemptTrace}. Runs on the same org-scoped transaction as the verdict insert, so a
 * partial or fabricated lifecycle can never persist a verdict.
 *
 * `attempted` (the production path): an orphan (no real attempt), a borrowed attempt from another
 * behavior, or a count that disagrees with the real attempt rows all throw BEFORE the verdict row
 * is written. `attemptless` (the justified escape hatch): fails closed unless ZERO real attempt
 * rows exist for the verdict's natural key — an attemptless verdict can never mask a run that
 * actually attempted the behavior (the exact untraceable-verdict fail-open the audit found).
 */
export async function assertVerdictTraceable(client: QueryClient, input: VerdictTraceabilityInput): Promise<void> {
  const actual = await countNaturalKeyAttempts(client, input);
  if (input.trace.kind === "attemptless") {
    if (actual > 0) throw new AttemptlessVerdictHasAttemptsError(input.runId, actual);
    return;
  }
  const producingAttemptId = input.trace.producingAttemptId;
  const producing = await client.query<{
    behavior_revision_id: string;
    example_hash: string;
    matrix_hash: string;
  }>(
    `SELECT behavior_revision_id, example_hash, matrix_hash
       FROM behavior_verification_attempts
      WHERE org_id = $1 AND id = $2 AND run_id = $3`,
    [input.orgId, producingAttemptId, input.runId],
  );
  const row = producing.rows[0];
  if (row === undefined) {
    throw new OrphanVerdictError(input.orgId, input.runId, producingAttemptId);
  }
  if (row.behavior_revision_id !== input.behaviorRevisionId) {
    throw new VerdictAttemptTraceabilityError(
      producingAttemptId,
      `attempt behavior ${row.behavior_revision_id} != verdict behavior ${input.behaviorRevisionId}`,
    );
  }
  if (row.example_hash !== input.exampleHash || row.matrix_hash !== input.matrixHash) {
    throw new VerdictAttemptTraceabilityError(
      producingAttemptId,
      `attempt example/matrix (${row.example_hash}/${row.matrix_hash}) != verdict (${input.exampleHash}/${input.matrixHash})`,
    );
  }
  if (actual === 0) {
    throw new OrphanVerdictError(input.orgId, input.runId, producingAttemptId);
  }
  if (actual !== input.attemptCount) {
    throw new VerdictAttemptCountMismatchError(input.runId, input.attemptCount, actual);
  }
}

/** Count the real attempt rows backing a verdict's (behavior, example, matrix) natural key. */
async function countNaturalKeyAttempts(
  client: QueryClient,
  input: Pick<VerdictTraceabilityInput, "orgId" | "runId" | "behaviorRevisionId" | "exampleHash" | "matrixHash">,
): Promise<number> {
  const counted = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM behavior_verification_attempts
      WHERE org_id = $1 AND run_id = $2 AND behavior_revision_id = $3
        AND example_hash = $4 AND matrix_hash = $5`,
    [input.orgId, input.runId, input.behaviorRevisionId, input.exampleHash, input.matrixHash],
  );
  return counted.rows[0]?.n ?? 0;
}

/**
 * Backfill each captured artifact's `producing_attempt_id` to the run's real attempt, but ONLY
 * where it is still NULL — never overwrite an existing attempt link. Runs inside the atomic
 * attempt+verdict transaction, so a production capture (persisted NULL before the attempt exists)
 * ends stamped with the real attempt, atomically with the verdict that links it.
 */
export async function backfillProducingAttempt(
  client: QueryClient,
  orgId: string,
  attemptId: string,
  artifactIds: readonly string[],
): Promise<void> {
  for (const artifactId of artifactIds) {
    await client.query(
      `UPDATE verification_artifacts
          SET producing_attempt_id = $3
        WHERE org_id = $1 AND id = $2 AND producing_attempt_id IS NULL`,
      [orgId, artifactId, attemptId],
    );
  }
}

/** Map a resolved behavior outcome to the attempt's stage-style classification tag. */
export function classifyAttemptOutcome(outcome: BehaviorVerdictOutcome): string {
  switch (outcome) {
    case "passed":
      return "product_resolved";
    case "failed_product":
    case "failed_visual":
      return "product_failure";
    case "failed_verification_contract":
      return "stale_contract";
    case "inconclusive_infrastructure":
      return "infra_failure";
    case "inconclusive_external":
    case "cancelled_superseded":
      return "inconclusive";
    default: {
      const exhaustive: never = outcome;
      throw new TypeError(`unknown behavior verdict outcome: ${String(exhaustive)}`);
    }
  }
}
