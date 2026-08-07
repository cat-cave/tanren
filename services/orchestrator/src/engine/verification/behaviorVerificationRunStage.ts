import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import type { ResolutionStageKind, ResolutionStageResult } from "../contracts/resolutionStage.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export type BehaviorVerificationRunPurpose =
  | "per_iteration"
  | "pre_audit"
  | "pre_merge"
  | "release_periodic"
  | "post_merge_production"
  | "manual_canary";

export type BehaviorVerificationRunStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

/** All required runtime-verification columns plus the self-healing lineage stamp. */
export interface WriteBehaviorVerificationRunStageInput {
  readonly orgId: string;
  readonly id: string;
  readonly projectId: string;
  readonly purpose: BehaviorVerificationRunPurpose;
  readonly environmentId: string;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly planSetHash: string;
  readonly runtimeBehaviorContextHash: string;
  readonly artifactDigest: string;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly stage: ResolutionStageKind;
  readonly resolutionJobId: string;
  readonly classification: ResolutionStageResult["classification"];
  readonly status?: BehaviorVerificationRunStatus;
  readonly runId?: string;
  readonly specId?: string;
  readonly integrationNodeId?: string;
}

export interface StartedBehaviorVerificationRunStage {
  readonly id: string;
  readonly status: BehaviorVerificationRunStatus;
  readonly classification: ResolutionStageResult["classification"];
  /** False only for a terminal receipt already completed by this job/stage. */
  readonly shouldRun: boolean;
}

/**
 * The complete request identity is read back after a conflict. `classification`
 * is included because its stage-specific terminal outcome is part of a receipt's
 * identity; `status` is deliberately excluded because a retry changes status.
 */
const IMMUTABLE_RECEIPT_COLUMNS = `org_id, id, project_id, purpose, run_id, spec_id, integration_node_id,
  environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash,
  artifact_digest, policy, stage, resolution_job_id, classification`;

interface PersistedBehaviorVerificationRunStage {
  readonly org_id: unknown;
  readonly id: unknown;
  readonly project_id: unknown;
  readonly purpose: unknown;
  readonly run_id: unknown;
  readonly spec_id: unknown;
  readonly integration_node_id: unknown;
  readonly environment_id: unknown;
  readonly prepared_head_sha: unknown;
  readonly jj_tree_id: unknown;
  readonly plan_set_hash: unknown;
  readonly runtime_behavior_context_hash: unknown;
  readonly artifact_digest: unknown;
  readonly policy: unknown;
  readonly stage: unknown;
  readonly resolution_job_id: unknown;
  readonly classification: unknown;
  readonly status: unknown;
}

type ReceiptState = Pick<PersistedBehaviorVerificationRunStage, "id" | "status" | "classification">;

export class BehaviorVerificationReceiptReplayError extends Error {
  public override readonly name = "BehaviorVerificationReceiptReplayError";
}

/** Write on the caller's RLS-scoped transaction with resolution-stage lineage. */
export async function writeBehaviorVerificationRunStage(
  client: QueryClient,
  input: WriteBehaviorVerificationRunStageInput,
): Promise<string> {
  const result = await client.query<{ id: unknown }>(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id,
        environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
        runtime_behavior_context_hash, artifact_digest, status, policy,
        stage, resolution_job_id, classification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)
     RETURNING id`,
    [
      input.orgId,
      input.id,
      input.projectId,
      input.purpose,
      input.runId ?? null,
      input.specId ?? null,
      input.integrationNodeId ?? null,
      input.environmentId,
      input.preparedHeadSha,
      input.jjTreeId,
      input.planSetHash,
      input.runtimeBehaviorContextHash,
      input.artifactDigest,
      input.status ?? "running",
      JSON.stringify(input.policy),
      input.stage,
      input.resolutionJobId,
      input.classification,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || typeof row.id !== "string") {
    throw new Error("behavior verification stage write returned no id");
  }
  return row.id;
}

/**
 * Start one durable verification receipt for a resolution job/stage. A recovery
 * may resume an interrupted or failed receipt, but never append a second row or
 * re-run a terminal receipt after the process crashed before job completion.
 */
export async function startBehaviorVerificationRunStage(
  client: QueryClient,
  input: WriteBehaviorVerificationRunStageInput,
): Promise<StartedBehaviorVerificationRunStage> {
  const result = await client.query<ReceiptState>(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id,
        environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
        runtime_behavior_context_hash, artifact_digest, status, policy,
        stage, resolution_job_id, classification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)
     ON CONFLICT DO NOTHING
     RETURNING id, status, classification`,
    writeParams(input),
  );
  const row = result.rows[0];
  if (row !== undefined) {
    return decodeStarted(insertedReceipt(row, input), input, row.status !== "completed");
  }

  const existing = await client.query<PersistedBehaviorVerificationRunStage>(
    `SELECT ${IMMUTABLE_RECEIPT_COLUMNS}, status
       FROM behavior_verification_runs
      WHERE org_id = $1 AND (id = $2 OR (resolution_job_id = $3 AND stage = $4))`,
    [input.orgId, input.id, input.resolutionJobId, input.stage],
  );
  if (existing.rows.length === 0) {
    throw new BehaviorVerificationReceiptReplayError(
      `verification stage receipt conflict is not visible for ${input.resolutionJobId}/${input.stage}`,
    );
  }
  if (existing.rows.length !== 1) {
    throw new BehaviorVerificationReceiptReplayError(
      `verification stage receipt identity collides with multiple rows for ${input.resolutionJobId}/${input.stage}`,
    );
  }
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new BehaviorVerificationReceiptReplayError("verification stage receipt read-back was empty");
  }
  return decodeStarted(existingRow, input, existingRow.status !== "completed");
}

function insertedReceipt(
  row: ReceiptState,
  input: WriteBehaviorVerificationRunStageInput,
): PersistedBehaviorVerificationRunStage {
  return {
    org_id: input.orgId,
    id: row.id,
    project_id: input.projectId,
    purpose: input.purpose,
    run_id: input.runId ?? null,
    spec_id: input.specId ?? null,
    integration_node_id: input.integrationNodeId ?? null,
    environment_id: input.environmentId,
    prepared_head_sha: input.preparedHeadSha,
    jj_tree_id: input.jjTreeId,
    plan_set_hash: input.planSetHash,
    runtime_behavior_context_hash: input.runtimeBehaviorContextHash,
    artifact_digest: input.artifactDigest,
    policy: input.policy,
    stage: input.stage,
    resolution_job_id: input.resolutionJobId,
    classification: row.classification,
    status: row.status,
  };
}

function writeParams(input: WriteBehaviorVerificationRunStageInput): unknown[] {
  return [
    input.orgId,
    input.id,
    input.projectId,
    input.purpose,
    input.runId ?? null,
    input.specId ?? null,
    input.integrationNodeId ?? null,
    input.environmentId,
    input.preparedHeadSha,
    input.jjTreeId,
    input.planSetHash,
    input.runtimeBehaviorContextHash,
    input.artifactDigest,
    input.status ?? "running",
    JSON.stringify(input.policy),
    input.stage,
    input.resolutionJobId,
    input.classification,
  ];
}

function decodeStarted(
  row: PersistedBehaviorVerificationRunStage,
  input: WriteBehaviorVerificationRunStageInput,
  shouldRun: boolean,
): StartedBehaviorVerificationRunStage {
  if (typeof row.id !== "string" || row.id.length === 0) throw new Error("verification stage receipt has no id");
  if (!isStatus(row.status)) throw new Error("verification stage receipt has an invalid status");
  if (!isClassification(row.classification))
    throw new Error("verification stage receipt has an invalid classification");
  assertReceiptIdentity(row, input);
  return { id: row.id, status: row.status, classification: row.classification, shouldRun };
}

function assertReceiptIdentity(
  row: PersistedBehaviorVerificationRunStage,
  input: WriteBehaviorVerificationRunStageInput,
): void {
  const persistedOutcome = terminalOutcome(row.stage, row.classification);
  const requestedOutcome = terminalOutcome(input.stage, input.classification);
  // The stage creates every receipt with `inconclusive` before the probe runs;
  // finalization replaces that provisional marker with its terminal classification.
  // A resumed request therefore validates the persisted terminal classification and
  // its derived outcome, while an explicitly terminal request must match both.
  const classificationMatches =
    input.classification === "inconclusive"
      ? persistedOutcome !== undefined
      : row.classification === input.classification && persistedOutcome === requestedOutcome;
  const matches =
    row.org_id === input.orgId &&
    row.id === input.id &&
    row.project_id === input.projectId &&
    row.purpose === input.purpose &&
    nullable(row.run_id) === nullable(input.runId) &&
    nullable(row.spec_id) === nullable(input.specId) &&
    nullable(row.integration_node_id) === nullable(input.integrationNodeId) &&
    row.environment_id === input.environmentId &&
    row.prepared_head_sha === input.preparedHeadSha &&
    row.jj_tree_id === input.jjTreeId &&
    row.plan_set_hash === input.planSetHash &&
    row.runtime_behavior_context_hash === input.runtimeBehaviorContextHash &&
    row.artifact_digest === input.artifactDigest &&
    row.stage === input.stage &&
    row.resolution_job_id === input.resolutionJobId &&
    classificationMatches &&
    policyMatches(row.policy, input.policy);

  if (!matches) {
    throw new BehaviorVerificationReceiptReplayError(
      `verification stage receipt identity mismatch for ${input.resolutionJobId}/${input.stage}`,
    );
  }
}

function nullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function policyMatches(persisted: unknown, requested: Readonly<Record<string, unknown>>): boolean {
  let requestedJson: unknown;
  try {
    requestedJson = JSON.parse(JSON.stringify(requested)) as unknown;
  } catch {
    return false;
  }
  let persistedJson = persisted;
  if (typeof persisted === "string") {
    try {
      persistedJson = JSON.parse(persisted) as unknown;
    } catch {
      return false;
    }
  }
  return isDeepStrictEqual(persistedJson, requestedJson);
}

type BehaviorVerificationOutcome = "passed" | "failed" | "inconclusive";

/** Derive the terminal outcome from the persisted stage classification. */
function terminalOutcome(stage: unknown, classification: unknown): BehaviorVerificationOutcome | undefined {
  if (!isStage(stage) || !isClassification(classification)) return undefined;
  if (classification === "infra_failure" || classification === "inconclusive") return "inconclusive";
  if (stage === "baseline") {
    if (classification === "product_failure") return "passed";
    if (classification === "stale_contract") return "failed";
    return undefined;
  }
  if (stage === "production") {
    if (classification === "product_resolved") return "passed";
    if (classification === "product_failure") return "failed";
    return undefined;
  }
  if (classification === "product_resolved") return "passed";
  return "failed";
}

function isStatus(value: unknown): value is BehaviorVerificationRunStatus {
  return (
    value === "planned" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
  );
}

function isStage(value: unknown): value is ResolutionStageKind {
  return value === "baseline" || value === "production" || value === "counterfactual" || value === "soak";
}

function isClassification(value: unknown): value is ResolutionStageResult["classification"] {
  return (
    value === "product_resolved" ||
    value === "product_failure" ||
    value === "infra_failure" ||
    value === "stale_contract" ||
    value === "inconclusive"
  );
}
