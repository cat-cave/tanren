// P3-0021 scheduled-audits store: the persistence seam over the `audit_jobs`
// table (migration 0025). Pure SQL + row mapping; no Answerer or inbox here.
// The scheduler (scheduler.ts) composes this with the pass runner + the inbox.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  AuditJob,
  AuditFindingsSummary,
  type AuditCadence,
  type AuditFindingsSummary as Summary,
  type AuditKind,
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface JobRow {
  id: string;
  org_id: string;
  project_id: string | null;
  kind: string;
  name: string;
  cadence: string;
  target_window: string;
  answerer_cli: string;
  enabled: string;
  last_run: Date | string | null;
  findings: unknown;
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapJob(row: JobRow): AuditJob {
  const findings: Summary = AuditFindingsSummary.parse(
    row.findings === null || typeof row.findings !== "object" ? {} : row.findings,
  );
  return AuditJob.parse({
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    cadence: row.cadence,
    targetWindow: row.target_window,
    answererCli: row.answerer_cli,
    enabled: row.enabled === "true",
    lastRun: isoOf(row.last_run),
    findings,
  });
}

const COLUMNS = "id, org_id, project_id, kind, name, cadence, target_window, answerer_cli, enabled, last_run, findings";

export interface CreateAuditJobInput {
  orgId: string;
  projectId: string | null;
  kind: AuditKind;
  name: string;
  cadence: AuditCadence;
  targetWindow?: string;
  answererCli?: string;
  enabled?: boolean;
}

export async function createAuditJob(client: QueryClient, input: CreateAuditJobInput): Promise<AuditJob> {
  const id = `audit_${randomUUID()}`;
  const result = await client.query<JobRow>(
    `INSERT INTO audit_jobs (id, org_id, project_id, kind, name, cadence, target_window, answerer_cli, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      id,
      input.orgId,
      input.projectId,
      input.kind,
      input.name,
      input.cadence,
      input.targetWindow ?? "",
      input.answererCli ?? "",
      input.enabled === false ? "false" : "true",
    ],
  );
  return mapJob(result.rows[0]!);
}

export async function listAuditJobs(client: QueryClient, orgId: string): Promise<AuditJob[]> {
  const result = await client.query<JobRow>(`SELECT ${COLUMNS} FROM audit_jobs WHERE org_id = $1 ORDER BY created_at`, [
    orgId,
  ]);
  return result.rows.map(mapJob);
}

export async function getAuditJob(client: QueryClient, jobId: string): Promise<AuditJob | undefined> {
  const result = await client.query<JobRow>(`SELECT ${COLUMNS} FROM audit_jobs WHERE id = $1`, [jobId]);
  const row = result.rows[0];
  return row === undefined ? undefined : mapJob(row);
}

// Flip the enable toggle; returns the updated job (or undefined if missing).
export async function setAuditJobEnabled(
  client: QueryClient,
  jobId: string,
  enabled: boolean,
): Promise<AuditJob | undefined> {
  const result = await client.query<JobRow>(
    `UPDATE audit_jobs SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [jobId, enabled ? "true" : "false"],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapJob(row);
}

// Record the outcome of a pass: stamp last_run + the findings roll-up.
export async function recordAuditRun(
  client: QueryClient,
  jobId: string,
  findings: Summary,
  ranAt: Date,
): Promise<AuditJob | undefined> {
  const result = await client.query<JobRow>(
    `UPDATE audit_jobs SET last_run = $2, findings = $3::jsonb, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [jobId, ranAt.toISOString(), JSON.stringify(findings)],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapJob(row);
}

// Every org that owns an audit job — the system-scoped fan-out the cross-org
// audit scheduler reads before listing each org's due jobs. DISTINCT, no
// predicate; byte-identical to the inline scheduler read.
export async function listDistinctAuditJobOrgIds(client: QueryClient): Promise<string[]> {
  const result = await client.query<{ org_id: string }>("SELECT DISTINCT org_id FROM audit_jobs");
  return result.rows.map((r) => r.org_id);
}

// The scheduled-audits data-access seam aggregated as a value object for the
// `Repositories` registry. The standalone functions stay exported for the
// scheduler/route call sites; the store object exposes the same methods.
export const AuditsStore = {
  createAuditJob,
  listAuditJobs,
  getAuditJob,
  setAuditJobEnabled,
  recordAuditRun,
  listDistinctAuditJobOrgIds,
} as const;
