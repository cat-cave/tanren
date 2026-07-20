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
  return id;
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
