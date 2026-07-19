// rv-23 — the DB read side of the runtime-verification DASHBOARD surfaces. Every
// query is org-scoped (runs on the caller-owned org-scoped client → RLS confines
// it to the caller's org, so a cross-org read sees ZERO rows), read-only (no
// INSERT/UPDATE), and returns proof state EXACTLY as persisted — a failed /
// inconclusive outcome is surfaced as-is and can never be laundered into passed.
// A behavior with NO verdict is surfaced UNPROVEN (null cell), never green.
//
// The shapes returned here match routes/proofDashboard/contract.ts, the versioned
// response contract the dashboard views decode.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type {
  BehaviorProofMatrixRow,
  DesignRenderVerdictView,
  EffectCausalitySummary,
  EffectObservationView,
  MatrixVerdictCell,
  QuarantineView,
  RegressionBisectionView,
} from "../../../routes/proofDashboard/contract.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;
type Row = Record<string, unknown>;

export interface ProjectScope {
  readonly orgId: string;
  readonly projectId: string;
}

function text(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`proof-dashboard read expected a non-empty string, got ${String(value)}`);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`proof-dashboard read expected an integer, got ${String(value)}`);
}

function toIntOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

// Decode a raw pg timestamp through a Zod boundary (z.coerce.date()) rather than
// casting it (audit RC-6 / no-pg-as-date).
const timestampSchema = z.coerce.date();
function toDate(value: unknown): Date {
  return timestampSchema.parse(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return [];
}

/** A single verdict cell (latest preview or latest production) from the matrix query. */
function verdictCell(
  outcome: unknown,
  required: unknown,
  executed: unknown,
  flake: unknown,
  artifact: unknown,
  runId: unknown,
  createdAt: unknown,
): MatrixVerdictCell | null {
  if (outcome === null || outcome === undefined) return null;
  return {
    outcome: text(outcome) as MatrixVerdictCell["outcome"],
    requiredAssertionCount: toInt(required),
    executedAssertionCount: toInt(executed),
    flakeState: text(flake) as MatrixVerdictCell["flakeState"],
    artifactDigest: text(artifact),
    runId: text(runId),
    createdAt: toDate(createdAt),
  };
}

// The matrix is one row per behavior REVISION. For each revision we LATERAL-join
// the newest PREVIEW-class verdict (per_iteration/pre_audit/pre_merge) and the
// newest PRODUCTION-class verdict (post_merge_production), plus the newest PASSED
// production verdict's artifact (the last-proven artifact), the current quarantine
// state, and the owning specs. Preview and production proof are distinct planes.
const PREVIEW_PURPOSES = "('per_iteration','pre_audit','pre_merge','release_periodic','manual_canary')";
const MATRIX_SELECT = `
  SELECT br.id AS behavior_revision_id, br.behavior_id, br.title, br.revision_number,
         br.status, br.design_contract_digest,
         COALESCE(specs.spec_ids, '{}') AS owning_spec_ids,
         COALESCE(tally.verdict_count, 0) AS verdict_count,
         prev.outcome AS preview_outcome, prev.required_assertion_count AS preview_required,
         prev.executed_assertion_count AS preview_executed, prev.flake_state AS preview_flake,
         prev.artifact_digest AS preview_artifact, prev.run_id AS preview_run, prev.created_at AS preview_created,
         prod.outcome AS prod_outcome, prod.required_assertion_count AS prod_required,
         prod.executed_assertion_count AS prod_executed, prod.flake_state AS prod_flake,
         prod.artifact_digest AS prod_artifact, prod.run_id AS prod_run, prod.created_at AS prod_created,
         proven.artifact_digest AS proven_artifact,
         q.transition AS quarantine_transition
    FROM behavior_revisions br
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT sb.spec_id) AS spec_ids
        FROM spec_behaviors sb WHERE sb.behavior_id = br.behavior_id
    ) specs ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS verdict_count FROM behavior_verdicts v
       WHERE v.org_id = br.org_id AND v.behavior_revision_id = br.id
    ) tally ON true
    LEFT JOIN LATERAL (
      SELECT v.outcome, v.required_assertion_count, v.executed_assertion_count, v.flake_state,
             v.artifact_digest, v.run_id, v.created_at
        FROM behavior_verdicts v
        JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
       WHERE v.org_id = br.org_id AND v.behavior_revision_id = br.id
         AND r.purpose IN ${PREVIEW_PURPOSES}
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1
    ) prev ON true
    LEFT JOIN LATERAL (
      SELECT v.outcome, v.required_assertion_count, v.executed_assertion_count, v.flake_state,
             v.artifact_digest, v.run_id, v.created_at
        FROM behavior_verdicts v
        JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
       WHERE v.org_id = br.org_id AND v.behavior_revision_id = br.id
         AND r.purpose = 'post_merge_production'
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1
    ) prod ON true
    LEFT JOIN LATERAL (
      SELECT v.artifact_digest
        FROM behavior_verdicts v
        JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
       WHERE v.org_id = br.org_id AND v.behavior_revision_id = br.id
         AND r.purpose = 'post_merge_production' AND v.outcome = 'passed'
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1
    ) proven ON true
    LEFT JOIN LATERAL (
      SELECT bq.transition
        FROM behavior_flake_quarantines bq
       WHERE bq.org_id = br.org_id AND bq.project_id = br.project_id
         AND bq.behavior_revision_id = br.id
       ORDER BY bq.created_at DESC, bq.id DESC LIMIT 1
    ) q ON true
   WHERE br.org_id = $1 AND br.project_id = $2
   ORDER BY br.behavior_id ASC, br.revision_number DESC
   LIMIT 1000`;

function matrixRow(row: Row): BehaviorProofMatrixRow {
  return {
    behaviorRevisionId: text(row["behavior_revision_id"]),
    behaviorId: text(row["behavior_id"]),
    title: typeof row["title"] === "string" ? row["title"] : "",
    revisionNumber: toInt(row["revision_number"]),
    status: text(row["status"]) as BehaviorProofMatrixRow["status"],
    designContractDigest: textOrNull(row["design_contract_digest"]),
    owningSpecIds: toStringArray(row["owning_spec_ids"]),
    latestPreview: verdictCell(
      row["preview_outcome"],
      row["preview_required"],
      row["preview_executed"],
      row["preview_flake"],
      row["preview_artifact"],
      row["preview_run"],
      row["preview_created"],
    ),
    latestProduction: verdictCell(
      row["prod_outcome"],
      row["prod_required"],
      row["prod_executed"],
      row["prod_flake"],
      row["prod_artifact"],
      row["prod_run"],
      row["prod_created"],
    ),
    lastProvenArtifactDigest: textOrNull(row["proven_artifact"]),
    quarantined: textOrNull(row["quarantine_transition"]) === "quarantine",
    verdictCount: toInt(row["verdict_count"]),
  };
}

/** Read-only runtime-verification dashboard surface. All reads run on the org-scoping pool. */
export class ProofDashboardReadStore {
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, withOrgScope?: OrgScope) {
    this.withOrgScope = withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  /** The Behavior Proof Matrix — one row per behavior revision, newest revision first. */
  public async readMatrix(scope: ProjectScope): Promise<readonly BehaviorProofMatrixRow[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<Row>(MATRIX_SELECT, [scope.orgId, scope.projectId]);
      return result.rows.map((row) => matrixRow(row));
    });
  }

  /** External-effect causality: this project's provider observations + the ok/missing/duplicate tally. */
  public async readEffectCausality(
    scope: ProjectScope,
  ): Promise<Omit<EffectCausalitySummary, "version" | "orgId" | "projectId">> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT observation_id, observer, provider, classification, trigger_id_hash, provider_object_hash,
                  occurrence_count, latency_ms, cursor, created_at
             FROM behavior_effect_observations
            WHERE org_id = $1 AND project_id = $2
            ORDER BY created_at DESC, observation_id DESC
            LIMIT 500`,
          [scope.orgId, scope.projectId],
        )
      ).rows;
      const observations: EffectObservationView[] = rows.map((row) => ({
        observationId: text(row["observation_id"]),
        observer: text(row["observer"]),
        provider: text(row["provider"]),
        classification: text(row["classification"]) as EffectObservationView["classification"],
        triggerIdHash: textOrNull(row["trigger_id_hash"]),
        providerObjectHash: textOrNull(row["provider_object_hash"]),
        occurrenceCount: toInt(row["occurrence_count"]),
        latencyMs: toIntOrNull(row["latency_ms"]),
        cursor: textOrNull(row["cursor"]),
        createdAt: toDate(row["created_at"]),
      }));
      const okCount = observations.filter((o) => o.classification === "ok").length;
      const missingCount = observations.filter((o) => o.classification === "missing").length;
      const duplicateCount = observations.filter((o) => o.classification === "duplicate").length;
      return { okCount, missingCount, duplicateCount, observations };
    });
  }

  /** Design-render (visual) land verdicts for the project, newest first. */
  public async readDesignRenderVerdicts(scope: ProjectScope): Promise<readonly DesignRenderVerdictView[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT id, design_system_id, release_id, design_contract_version, contract_digest,
                  accessibility_standard, outcome, checkpoint_count, passed_count, failed_count,
                  inconclusive_count, failing_scenario_key, failing_rule_ids, created_at
             FROM design_render_land_verdicts
            WHERE org_id = $1 AND project_id = $2
            ORDER BY created_at DESC, id DESC
            LIMIT 500`,
          [scope.orgId, scope.projectId],
        )
      ).rows;
      return rows.map((row) => ({
        id: text(row["id"]),
        designSystemId: text(row["design_system_id"]),
        releaseId: text(row["release_id"]),
        designContractVersion: text(row["design_contract_version"]),
        contractDigest: textOrNull(row["contract_digest"]),
        accessibilityStandard: text(row["accessibility_standard"]),
        outcome: text(row["outcome"]) as DesignRenderVerdictView["outcome"],
        checkpointCount: toInt(row["checkpoint_count"]),
        passedCount: toInt(row["passed_count"]),
        failedCount: toInt(row["failed_count"]),
        inconclusiveCount: toInt(row["inconclusive_count"]),
        failingScenarioKey: textOrNull(row["failing_scenario_key"]),
        failingRuleIds: toStringArray(row["failing_rule_ids"]),
        createdAt: toDate(row["created_at"]),
      }));
    });
  }

  /** Merge-queue behavior-aware regression bisections for the project, newest first. */
  public async readRegressionBisections(scope: ProjectScope): Promise<readonly RegressionBisectionView[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT id, behavior_revision_id, status, failing_release_instance_id, failing_verdict_id,
                  baseline_release_instance_id, culprit_release_instance_id, culprit_integration_node_id,
                  inconclusive_reason, candidate_count, probe_count, created_at
             FROM behavior_regression_bisections
            WHERE org_id = $1 AND project_id = $2
            ORDER BY created_at DESC, id DESC
            LIMIT 500`,
          [scope.orgId, scope.projectId],
        )
      ).rows;
      return rows.map((row) => ({
        id: text(row["id"]),
        behaviorRevisionId: text(row["behavior_revision_id"]),
        status: text(row["status"]) as RegressionBisectionView["status"],
        failingReleaseInstanceId: text(row["failing_release_instance_id"]),
        failingVerdictId: text(row["failing_verdict_id"]),
        baselineReleaseInstanceId: textOrNull(row["baseline_release_instance_id"]),
        culpritReleaseInstanceId: textOrNull(row["culprit_release_instance_id"]),
        culpritIntegrationNodeId: textOrNull(row["culprit_integration_node_id"]),
        inconclusiveReason: textOrNull(row["inconclusive_reason"]),
        candidateCount: toInt(row["candidate_count"]),
        probeCount: toInt(row["probe_count"]),
        createdAt: toDate(row["created_at"]),
      }));
    });
  }

  /**
   * Flake / quarantine current state — the LATEST transition per behavior revision.
   * A `quarantine` transition is surfaced as `quarantined`, a `release` as
   * `released`. The append-only ledger can never assert a green effect for a
   * quarantine (DB shape CHECK), so this view never launders a quarantine into a pass.
   */
  public async readFlakeQuarantines(scope: ProjectScope): Promise<readonly QuarantineView[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT DISTINCT ON (bq.behavior_revision_id)
                  bq.behavior_revision_id, bq.id, bq.transition, bq.classification, bq.gate_effect,
                  bq.reason, bq.actor, bq.context_hash, bq.created_at,
                  jsonb_array_length(bq.evidence) AS evidence_count
             FROM behavior_flake_quarantines bq
            WHERE bq.org_id = $1 AND bq.project_id = $2
            ORDER BY bq.behavior_revision_id, bq.created_at DESC, bq.id DESC
            LIMIT 500`,
          [scope.orgId, scope.projectId],
        )
      ).rows;
      return rows.map((row) => ({
        behaviorRevisionId: text(row["behavior_revision_id"]),
        state: text(row["transition"]) === "quarantine" ? "quarantined" : "released",
        transitionId: text(row["id"]),
        classification: text(row["classification"]),
        gateEffect: text(row["gate_effect"]),
        reason: typeof row["reason"] === "string" ? row["reason"] : "",
        actor: text(row["actor"]),
        contextHash: text(row["context_hash"]),
        evidenceVerdictCount: toInt(row["evidence_count"]),
        createdAt: toDate(row["created_at"]),
      }));
    });
  }
}
