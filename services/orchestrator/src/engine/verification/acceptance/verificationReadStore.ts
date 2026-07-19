// rv-22 — the DB read side of the runtime-verification HTTP read surface. Every
// query is org-scoped (runs on the caller-owned org-scoped client → RLS confines
// it to the caller's org, so a cross-org read sees ZERO rows), read-only (no
// INSERT/UPDATE), and returns verdicts EXACTLY as persisted — a failed or
// inconclusive outcome is surfaced as-is and can never be laundered into passed.
//
// The shapes returned here match routes/runtimeVerification/contract.ts, the
// versioned response contract the rv-read-compat guard pins.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type {
  BehaviorVerdictHistory,
  VerificationEnvironmentBinding,
  VerificationRunDetail,
  VerificationRunHeader,
  VerificationVerdictView,
} from "../../../routes/runtimeVerification/contract.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;
type Row = Record<string, unknown>;

export interface ProjectScope {
  readonly orgId: string;
  readonly projectId: string;
}

function text(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`verification read expected a non-empty string, got ${String(value)}`);
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
  throw new Error(`verification read expected an integer, got ${String(value)}`);
}

// Decode a raw pg timestamp through a Zod boundary (z.coerce.date()) rather than
// casting it — a laundering `as Date` would silently hand garbage to the consumer
// if the column type changed or the value were NULL (audit RC-6 / no-pg-as-date).
const timestampSchema = z.coerce.date();

function toDate(value: unknown): Date {
  return timestampSchema.parse(value);
}

function verdictView(row: Row): VerificationVerdictView {
  return {
    verdictId: text(row["id"]),
    behaviorRevisionId: text(row["behavior_revision_id"]),
    outcome: text(row["outcome"]) as VerificationVerdictView["outcome"],
    requiredAssertionCount: toInt(row["required_assertion_count"]),
    executedAssertionCount: toInt(row["executed_assertion_count"]),
    attemptCount: toInt(row["attempt_count"]),
    flakeState: text(row["flake_state"]) as VerificationVerdictView["flakeState"],
    gateEffect: text(row["gate_effect"]) as VerificationVerdictView["gateEffect"],
    artifactDigest: text(row["artifact_digest"]),
    proofUnitDigest: textOrNull(row["proof_unit_digest"]),
    runtimeBehaviorContextHash: text(row["runtime_behavior_context_hash"]),
  };
}

function environmentBinding(row: Row | undefined): VerificationEnvironmentBinding | null {
  if (row === undefined) return null;
  return {
    environmentId: text(row["id"]),
    projectId: text(row["project_id"]),
    integrationNodeId: text(row["integration_node_id"]),
    artifactDigest: text(row["artifact_digest"]),
    deploymentTarget: text(row["deployment_target"]),
    environmentFingerprint: text(row["environment_fingerprint"]),
    lifecycleStatus: text(row["lifecycle_status"]) as VerificationEnvironmentBinding["lifecycleStatus"],
  };
}

/** A run-header row already joined with its verdict tally + latest outcome. */
function runHeader(row: Row): VerificationRunHeader {
  return {
    runId: text(row["id"]),
    projectId: text(row["project_id"]),
    purpose: text(row["purpose"]) as VerificationRunHeader["purpose"],
    status: text(row["status"]) as VerificationRunHeader["status"],
    specId: textOrNull(row["spec_id"]),
    integrationNodeId: textOrNull(row["integration_node_id"]),
    environmentId: text(row["environment_id"]),
    artifactDigest: text(row["artifact_digest"]),
    createdAt: toDate(row["created_at"]),
    verdictCount: toInt(row["verdict_count"]),
    latestOutcome: (textOrNull(row["latest_outcome"]) as VerificationRunHeader["latestOutcome"]) ?? null,
  };
}

// The run-header projection is shared by the list + detail queries: it LEFT JOINs
// a per-run verdict tally + the newest verdict's outcome so a caller sees a run's
// latest status without a second round trip.
const RUN_HEADER_SELECT = `
  SELECT r.id, r.project_id, r.purpose, r.status, r.spec_id, r.integration_node_id,
         r.environment_id, r.artifact_digest, r.created_at,
         COALESCE(v.verdict_count, 0) AS verdict_count,
         latest.outcome AS latest_outcome
    FROM behavior_verification_runs r
    LEFT JOIN (
      SELECT run_id, COUNT(*)::int AS verdict_count
        FROM behavior_verdicts
       WHERE org_id = $1
       GROUP BY run_id
    ) v ON v.run_id = r.id
    LEFT JOIN LATERAL (
      SELECT outcome
        FROM behavior_verdicts bv
       WHERE bv.org_id = $1 AND bv.run_id = r.id
       ORDER BY bv.created_at DESC, bv.id DESC
       LIMIT 1
    ) latest ON true
   WHERE r.org_id = $1`;

/** Read-only runtime-verification surface. All reads run on the org-scoping pool. */
export class VerificationReadStore {
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, withOrgScope?: OrgScope) {
    this.withOrgScope = withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  /** List a project's acceptance runs, newest first, each with its verdict tally + latest outcome. */
  public async listRuns(scope: ProjectScope): Promise<readonly VerificationRunHeader[]> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const result = await client.query<Row>(
        `${RUN_HEADER_SELECT} AND r.project_id = $2 ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
        [scope.orgId, scope.projectId],
      );
      return result.rows.map((row) => runHeader(row));
    });
  }

  /** One run's detail (header + environment binding + verdicts), or undefined when invisible. */
  public async readRunDetail(
    scope: ProjectScope,
    runId: string,
  ): Promise<Omit<VerificationRunDetail, "version" | "orgId" | "projectId" | "proofBundleHref"> | undefined> {
    return this.withOrgScope(
      scope.orgId,
      async (
        client,
      ): Promise<Omit<VerificationRunDetail, "version" | "orgId" | "projectId" | "proofBundleHref"> | undefined> => {
        const runRow = (
          await client.query<Row>(`${RUN_HEADER_SELECT} AND r.project_id = $2 AND r.id = $3`, [
            scope.orgId,
            scope.projectId,
            runId,
          ])
        ).rows[0];
        if (runRow === undefined) return undefined;

        const envRow = (
          await client.query<Row>(
            `SELECT id, project_id, integration_node_id, artifact_digest, deployment_target,
                  environment_fingerprint, lifecycle_status
             FROM verification_environments
            WHERE org_id = $1 AND id = $2`,
            [scope.orgId, textOrNull(runRow["environment_id"])],
          )
        ).rows[0];

        const verdictRows = (
          await client.query<Row>(
            `SELECT id, behavior_revision_id, outcome, required_assertion_count, executed_assertion_count,
                  attempt_count, flake_state, gate_effect, artifact_digest, proof_unit_digest,
                  runtime_behavior_context_hash
             FROM behavior_verdicts
            WHERE org_id = $1 AND run_id = $2
            ORDER BY created_at ASC, id ASC`,
            [scope.orgId, runId],
          )
        ).rows;

        return {
          run: runHeader(runRow),
          environment: environmentBinding(envRow),
          verdicts: verdictRows.map((row) => verdictView(row)),
        };
      },
    );
  }

  /** A behavior's verdict history across every run, newest first, with the latest outcome. */
  public async readBehaviorHistory(
    scope: ProjectScope,
    behaviorRevisionId: string,
  ): Promise<Omit<BehaviorVerdictHistory, "version" | "orgId" | "projectId" | "behaviorRevisionId">> {
    return this.withOrgScope(scope.orgId, async (client) => {
      const rows = (
        await client.query<Row>(
          `SELECT v.id, v.behavior_revision_id, v.outcome, v.required_assertion_count, v.executed_assertion_count,
                  v.attempt_count, v.flake_state, v.gate_effect, v.artifact_digest, v.proof_unit_digest,
                  v.runtime_behavior_context_hash, v.created_at,
                  r.id AS run_id, r.purpose AS run_purpose, r.status AS run_status
             FROM behavior_verdicts v
             JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
            WHERE v.org_id = $1 AND r.project_id = $2 AND v.behavior_revision_id = $3
            ORDER BY v.created_at DESC, v.id DESC
            LIMIT 500`,
          [scope.orgId, scope.projectId, behaviorRevisionId],
        )
      ).rows;

      const verdicts = rows.map((row) => ({
        runId: text(row["run_id"]),
        runPurpose: text(row["run_purpose"]) as BehaviorVerdictHistory["verdicts"][number]["runPurpose"],
        runStatus: text(row["run_status"]) as BehaviorVerdictHistory["verdicts"][number]["runStatus"],
        createdAt: toDate(row["created_at"]),
        verdict: verdictView(row),
      }));
      const latestOutcome = verdicts[0]?.verdict.outcome ?? null;
      return { latestOutcome, verdicts };
    });
  }
}
