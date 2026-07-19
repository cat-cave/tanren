// rv-24 — the DB side of the exportable proof bundle. `collectBundleEvidence` reads the
// full acceptance evidence for one behavior-verification run from the durable /
// append-only spine tables (all org-scoped, so a cross-org export sees zero rows);
// `buildProofBundle` (pure, in `proofBundle.ts`) then chains it into a tamper-evident,
// offline-verifiable document. There is NO endpoint that mints or mutates a bundle — a
// bundle is assembled READ-ONLY from the real persisted rows, so it can never launder a
// failed verdict into a passed one.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { SealedResolutionProof } from "../../governance/resolutionProof.js";
import {
  buildProofBundle,
  type BundleEnvironmentSection,
  type BundleRunSection,
  type BundleVerdictAssertionEvidence,
  type BundleVerdictAttemptEvidence,
  type BundleVerdictSection,
  type ProofBundle,
  type ProofBundleEvidence,
} from "./proofBundle.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;
type Row = Record<string, unknown>;

export type ProofBundleExportInput = {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireText(value: unknown, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new Error(`proof bundle evidence has no ${field}`);
  return text;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`proof bundle evidence expected an integer, got ${String(value)}`);
}

function bool(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`proof bundle evidence expected ${field} to be boolean, got ${String(value)}`);
}

function runSection(row: Row): BundleRunSection {
  return {
    runId: requireText(row["id"], "behavior_verification_runs.id"),
    projectId: requireText(row["project_id"], "behavior_verification_runs.project_id"),
    purpose: requireText(row["purpose"], "behavior_verification_runs.purpose"),
    status: requireText(row["status"], "behavior_verification_runs.status"),
    stage: textOrNull(row["stage"]),
    classification: textOrNull(row["classification"]),
    resolutionJobId: textOrNull(row["resolution_job_id"]),
    specId: textOrNull(row["spec_id"]),
    integrationNodeId: textOrNull(row["integration_node_id"]),
    preparedHeadSha: requireText(row["prepared_head_sha"], "prepared_head_sha"),
    jjTreeId: requireText(row["jj_tree_id"], "jj_tree_id"),
    planSetHash: requireText(row["plan_set_hash"], "plan_set_hash"),
    runtimeBehaviorContextHash: requireText(row["runtime_behavior_context_hash"], "runtime_behavior_context_hash"),
    artifactDigest: requireText(row["artifact_digest"], "artifact_digest"),
  };
}

function environmentSection(row: Row | undefined): BundleEnvironmentSection | null {
  if (row === undefined) return null;
  return {
    environmentId: requireText(row["id"], "verification_environments.id"),
    projectId: requireText(row["project_id"], "verification_environments.project_id"),
    integrationNodeId: requireText(row["integration_node_id"], "verification_environments.integration_node_id"),
    artifactDigest: requireText(row["artifact_digest"], "verification_environments.artifact_digest"),
    deploymentTarget: requireText(row["deployment_target"], "verification_environments.deployment_target"),
    environmentFingerprint: requireText(row["environment_fingerprint"], "environment_fingerprint"),
    tenantLeaseId: requireText(row["tenant_lease_id"], "tenant_lease_id"),
    lifecycleStatus: requireText(row["lifecycle_status"], "lifecycle_status"),
  };
}

function verdictSection(
  row: Row,
  assertionEvidence: readonly BundleVerdictAssertionEvidence[],
  attemptEvidence: readonly BundleVerdictAttemptEvidence[],
): BundleVerdictSection {
  const section: BundleVerdictSection = {
    verdictId: requireText(row["id"], "behavior_verdicts.id"),
    behaviorRevisionId: requireText(row["behavior_revision_id"], "behavior_revision_id"),
    outcome: requireText(row["outcome"], "behavior_verdicts.outcome"),
    requiredAssertionCount: toInt(row["required_assertion_count"]),
    executedAssertionCount: toInt(row["executed_assertion_count"]),
    attemptCount: toInt(row["attempt_count"]),
    flakeState: requireText(row["flake_state"], "flake_state"),
    gateEffect: requireText(row["gate_effect"], "gate_effect"),
    exampleHash: requireText(row["example_hash"], "example_hash"),
    matrixHash: requireText(row["matrix_hash"], "matrix_hash"),
    artifactDigest: requireText(row["artifact_digest"], "behavior_verdicts.artifact_digest"),
    proofUnitDigest: textOrNull(row["proof_unit_digest"]),
    runtimeBehaviorContextHash: requireText(row["runtime_behavior_context_hash"], "runtime_behavior_context_hash"),
    assertionEvidence,
    attemptEvidence,
  };
  const executed = assertionEvidence.filter((assertion) => assertion.executed).length;
  if (
    section.requiredAssertionCount !== assertionEvidence.length ||
    section.executedAssertionCount !== executed ||
    section.attemptCount !== attemptEvidence.length
  ) {
    throw new Error(`proof bundle cannot export unverifiable counts for verdict ${section.verdictId}`);
  }
  return section;
}

/**
 * Gather every evidence section for one acceptance run. Returns undefined only when the
 * run itself is not visible (fail-closed: a caller never exports a bundle over evidence
 * it cannot read). All reads run SEQUENTIALLY on the single caller-owned org-scoped
 * client, so RLS confines them to the caller's org.
 */
export async function collectBundleEvidence(
  client: QueryClient,
  input: ProofBundleExportInput,
): Promise<ProofBundleEvidence | undefined> {
  const { orgId, projectId, runId } = input;
  const runRow = (
    await client.query<Row>(
      `SELECT id, project_id, purpose, status, stage, classification, resolution_job_id, spec_id,
              integration_node_id, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash,
              runtime_behavior_context_hash, artifact_digest
         FROM behavior_verification_runs
        WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [orgId, projectId, runId],
    )
  ).rows[0];
  if (runRow === undefined) return undefined;

  const environmentRow = (
    await client.query<Row>(
      `SELECT id, project_id, integration_node_id, artifact_digest, deployment_target,
              environment_fingerprint, tenant_lease_id, lifecycle_status
         FROM verification_environments
        WHERE org_id = $1 AND id = $2`,
      [orgId, textOrNull(runRow["environment_id"])],
    )
  ).rows[0];

  const verdictRows = (
    await client.query<Row>(
      `SELECT id, behavior_revision_id, outcome, required_assertion_count, executed_assertion_count,
              attempt_count, flake_state, gate_effect, example_hash, matrix_hash, artifact_digest,
              proof_unit_digest, runtime_behavior_context_hash
         FROM behavior_verdicts
        WHERE org_id = $1 AND run_id = $2
        ORDER BY created_at ASC, id ASC`,
      [orgId, runId],
    )
  ).rows;
  const assertionRows = (
    await client.query<Row>(
      `SELECT verdict_id, assertion_id, executed, passed
         FROM behavior_verdict_assertions
        WHERE org_id = $1
          AND verdict_id IN (SELECT id FROM behavior_verdicts WHERE org_id = $1 AND run_id = $2)
        ORDER BY verdict_id ASC, assertion_id ASC`,
      [orgId, runId],
    )
  ).rows;
  const attemptRows = (
    await client.query<Row>(
      `SELECT verdict_id, attempt_ordinal, outcome
         FROM behavior_verdict_attempts
        WHERE org_id = $1
          AND verdict_id IN (SELECT id FROM behavior_verdicts WHERE org_id = $1 AND run_id = $2)
        ORDER BY verdict_id ASC, attempt_ordinal ASC`,
      [orgId, runId],
    )
  ).rows;
  const assertionsByVerdict = new Map<string, BundleVerdictAssertionEvidence[]>();
  for (const row of assertionRows) {
    const verdictId = requireText(row["verdict_id"], "behavior_verdict_assertions.verdict_id");
    const evidence = assertionsByVerdict.get(verdictId) ?? [];
    evidence.push({
      assertionId: requireText(row["assertion_id"], "behavior_verdict_assertions.assertion_id"),
      executed: bool(row["executed"], "behavior_verdict_assertions.executed"),
      passed: row["passed"] === null ? null : bool(row["passed"], "behavior_verdict_assertions.passed"),
    });
    assertionsByVerdict.set(verdictId, evidence);
  }
  const attemptsByVerdict = new Map<string, BundleVerdictAttemptEvidence[]>();
  for (const row of attemptRows) {
    const verdictId = requireText(row["verdict_id"], "behavior_verdict_attempts.verdict_id");
    const evidence = attemptsByVerdict.get(verdictId) ?? [];
    evidence.push({
      attemptOrdinal: toInt(row["attempt_ordinal"]),
      outcome: requireText(row["outcome"], "behavior_verdict_attempts.outcome"),
    });
    attemptsByVerdict.set(verdictId, evidence);
  }

  // A run born of an issue-loop resolution carries the bh-14a resolution proofs — the
  // sealed chain is stored as the full SealedResolutionProof JSON, self-verifiable.
  const resolutionJobId = textOrNull(runRow["resolution_job_id"]);
  const resolutionProofRows = (
    await client.query<Row>(
      `SELECT proof_json FROM resolution_proofs
        WHERE org_id = $1 AND resolution_job_id = $2
        ORDER BY created_at ASC, id ASC`,
      [orgId, resolutionJobId],
    )
  ).rows;

  return {
    orgId,
    projectId,
    runId,
    run: runSection(runRow),
    environment: environmentSection(environmentRow),
    verdicts: verdictRows.map((row) => {
      const verdictId = requireText(row["id"], "behavior_verdicts.id");
      return verdictSection(row, assertionsByVerdict.get(verdictId) ?? [], attemptsByVerdict.get(verdictId) ?? []);
    }),
    resolutionProofs: resolutionProofRows.map((row) => row["proof_json"] as SealedResolutionProof),
  };
}

/** Read-only bundle export surface for the GET route. Reads run on the org-scoping pool. */
export class ProofBundleStore {
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, withOrgScope?: OrgScope) {
    this.withOrgScope = withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  /** Export the tamper-evident bundle for one run, or undefined when the run is invisible. */
  public async exportForRun(input: ProofBundleExportInput): Promise<ProofBundle | undefined> {
    return this.withOrgScope(input.orgId, async (client) => {
      const evidence = await collectBundleEvidence(client, input);
      return evidence === undefined ? undefined : buildProofBundle(evidence);
    });
  }
}
