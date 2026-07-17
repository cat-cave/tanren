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
  const result = await client.query<{ id: unknown; status: unknown; classification: unknown }>(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id,
        environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
        runtime_behavior_context_hash, artifact_digest, status, policy,
        stage, resolution_job_id, classification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)
     ON CONFLICT (resolution_job_id, stage) DO UPDATE
       SET status = EXCLUDED.status,
           classification = EXCLUDED.classification
     WHERE behavior_verification_runs.status = 'failed'
     RETURNING id, status, classification`,
    writeParams(input),
  );
  const row = result.rows[0];
  if (row !== undefined) return decodeStarted(row, true);

  const existing = await client.query<{ id: unknown; status: unknown; classification: unknown }>(
    `SELECT id, status, classification
       FROM behavior_verification_runs
      WHERE resolution_job_id = $1 AND stage = $2`,
    [input.resolutionJobId, input.stage],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new Error(`verification stage receipt disappeared for ${input.resolutionJobId}/${input.stage}`);
  }
  return decodeStarted(existingRow, existingRow.status !== "completed");
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
  row: { id: unknown; status: unknown; classification: unknown },
  shouldRun: boolean,
): StartedBehaviorVerificationRunStage {
  if (typeof row.id !== "string" || row.id.length === 0) throw new Error("verification stage receipt has no id");
  if (!isStatus(row.status)) throw new Error("verification stage receipt has an invalid status");
  if (!isClassification(row.classification))
    throw new Error("verification stage receipt has an invalid classification");
  return { id: row.id, status: row.status, classification: row.classification, shouldRun };
}

function isStatus(value: unknown): value is BehaviorVerificationRunStatus {
  return (
    value === "planned" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
  );
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
