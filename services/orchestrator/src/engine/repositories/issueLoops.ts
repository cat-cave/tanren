// cspell:ignore iloop sfind

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const ISSUE_LOOP_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const ISSUE_LOOP_STATES = [
  "open",
  "awaiting_reproduction",
  "reproduced",
  "triaged",
  "remediating",
  "verifying",
  "verified_source_sync_pending",
  "verified_closed",
  "externally_closed_unverified",
  "needs_attention",
  "wont_fix",
] as const;
export const ISSUE_LOOP_RESOLUTION_POLICIES = [
  "active_causal",
  "active_plus_soak",
  "observational",
  "attested",
] as const;
export const SOURCE_FINDING_STATUSES = ["open", "closed", "reopened", "edited", "deleted", "unknown"] as const;
export const ISSUE_LOOP_RELATIONS = ["duplicate_of", "supersedes", "regression_of", "caused_by", "split_from"] as const;

const IssueLoopSeverity = z.enum(ISSUE_LOOP_SEVERITIES);
export type IssueLoopSeverity = z.infer<typeof IssueLoopSeverity>;
const IssueLoopState = z.enum(ISSUE_LOOP_STATES);
export type IssueLoopState = z.infer<typeof IssueLoopState>;
const IssueLoopResolutionPolicy = z.enum(ISSUE_LOOP_RESOLUTION_POLICIES);
export type IssueLoopResolutionPolicy = z.infer<typeof IssueLoopResolutionPolicy>;
const SourceFindingStatus = z.enum(SOURCE_FINDING_STATUSES);
export type SourceFindingStatus = z.infer<typeof SourceFindingStatus>;
const IssueLoopRelation = z.enum(ISSUE_LOOP_RELATIONS);
export type IssueLoopRelation = z.infer<typeof IssueLoopRelation>;

const JsonRecord = z.record(z.string(), z.unknown());

export const IssueLoopRow = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  externalKey: z.string().min(1),
  generation: z.number().int().min(1),
  fingerprint: z.string().min(1),
  severity: IssueLoopSeverity,
  state: IssueLoopState,
  sourceRevisionId: z.string().nullable(),
  currentContractId: z.string().nullable(),
  currentAttemptId: z.string().nullable(),
  resolutionPolicy: IssueLoopResolutionPolicy,
  rowVersion: z.number().int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type IssueLoopRow = z.infer<typeof IssueLoopRow>;
export const SourceFindingRow = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  issueLoopId: z.string().min(1),
  sourceId: z.string().min(1),
  providerObjectId: z.string().min(1),
  providerRevision: z.string().min(1),
  deliveryId: z.string().nullable(),
  status: SourceFindingStatus,
  release: z.string().nullable(),
  environment: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  context: JsonRecord,
  fingerprint: z.string().min(1),
  observedAt: z.date(),
  rawArtifactRef: z.string().nullable(),
  createdAt: z.date(),
});
export type SourceFindingRow = z.infer<typeof SourceFindingRow>;
interface RawIssueLoopRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  source_id: unknown;
  external_key: unknown;
  generation: unknown;
  fingerprint: unknown;
  severity: unknown;
  state: unknown;
  source_revision_id: unknown;
  current_contract_id: unknown;
  current_attempt_id: unknown;
  resolution_policy: unknown;
  row_version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RawSourceFindingRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  issue_loop_id: unknown;
  source_id: unknown;
  provider_object_id: unknown;
  provider_revision: unknown;
  delivery_id: unknown;
  status: unknown;
  release: unknown;
  environment: unknown;
  title: unknown;
  body: unknown;
  context: unknown;
  fingerprint: unknown;
  observed_at: unknown;
  raw_artifact_ref: unknown;
  created_at: unknown;
}

const ISSUE_LOOP_COLUMNS = `
  org_id, id, project_id, source_id, external_key, generation, fingerprint,
  severity, state, source_revision_id, current_contract_id, current_attempt_id,
  resolution_policy, row_version, created_at, updated_at
`;

const SOURCE_FINDING_COLUMNS = `
  org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
  provider_revision, delivery_id, status, release, environment, title, body,
  context, fingerprint, observed_at, raw_artifact_ref, created_at
`;

function decodeIssueLoop(row: RawIssueLoopRow): IssueLoopRow {
  return IssueLoopRow.parse({
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    externalKey: row.external_key,
    generation: Number(row.generation),
    fingerprint: row.fingerprint,
    severity: row.severity,
    state: row.state,
    sourceRevisionId: row.source_revision_id,
    currentContractId: row.current_contract_id,
    currentAttemptId: row.current_attempt_id,
    resolutionPolicy: row.resolution_policy,
    rowVersion: Number(row.row_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodeSourceFinding(row: RawSourceFindingRow): SourceFindingRow {
  return SourceFindingRow.parse({
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    issueLoopId: row.issue_loop_id,
    sourceId: row.source_id,
    providerObjectId: row.provider_object_id,
    providerRevision: row.provider_revision,
    deliveryId: row.delivery_id,
    status: row.status,
    release: row.release,
    environment: row.environment,
    title: row.title,
    body: row.body,
    context: row.context,
    fingerprint: row.fingerprint,
    observedAt: row.observed_at,
    rawArtifactRef: row.raw_artifact_ref,
    createdAt: row.created_at,
  });
}

export interface CreateIssueLoopInput {
  orgId: string;
  projectId: string;
  sourceId: string;
  externalKey: string;
  fingerprint: string;
  severity: IssueLoopSeverity;
  generation?: number;
  state?: IssueLoopState;
  sourceRevisionId?: string | null;
  resolutionPolicy?: IssueLoopResolutionPolicy;
}
export interface AppendSourceFindingInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  sourceId: string;
  providerObjectId: string;
  providerRevision: string;
  status: SourceFindingStatus;
  title: string;
  fingerprint: string;
  observedAt: Date;
  deliveryId?: string | null;
  release?: string | null;
  environment?: string | null;
  body?: string;
  context?: Record<string, unknown>;
  rawArtifactRef?: string | null;
}
export interface LinkIssueLoopEdgeInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  relatedIssueLoopId: string;
  relation: IssueLoopRelation;
}
export interface UpsertIssueLoopForSourceInput {
  orgId: string;
  projectId: string;
  sourceId: string;
  externalKey: string;
  fingerprint: string;
  severity: IssueLoopSeverity;
  sourceRevisionId?: string | null;
  generation?: number;
  resolutionPolicy?: IssueLoopResolutionPolicy;
}
export interface AppendSourceFindingResult {
  finding: SourceFindingRow;
  inserted: boolean;
}
export interface TransitionIssueLoopInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  toState: IssueLoopState;
  fromState?: IssueLoopState;
}
export interface TransitionIssueLoopResult {
  loop: IssueLoopRow;
  changed: boolean;
}
export class IssueLoopNotFoundError extends Error {
  override readonly name = "IssueLoopNotFoundError";
  constructor(readonly loopId: string) {
    super(`issue loop ${loopId} not found`);
  }
}

export const IssueLoopStore = {
  async create(client: QueryClient, input: CreateIssueLoopInput): Promise<IssueLoopRow> {
    const id = `iloop_${randomUUID()}`;
    const result = await client.query<RawIssueLoopRow>(
      `INSERT INTO issue_loops
         (org_id, id, project_id, source_id, external_key, generation, fingerprint,
          severity, state, source_revision_id, resolution_policy, row_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.sourceId,
        input.externalKey,
        input.generation ?? 1,
        input.fingerprint,
        input.severity,
        input.state ?? "open",
        input.sourceRevisionId ?? null,
        input.resolutionPolicy ?? "active_causal",
      ],
    );
    return decodeIssueLoop(result.rows[0]!);
  },

  async upsertForSource(client: QueryClient, input: UpsertIssueLoopForSourceInput): Promise<IssueLoopRow> {
    const id = `iloop_${randomUUID()}`;
    const result = await client.query<RawIssueLoopRow>(
      `INSERT INTO issue_loops
         (org_id, id, project_id, source_id, external_key, generation, fingerprint,
          severity, state, source_revision_id, resolution_policy, row_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, 1, now())
       ON CONFLICT (org_id, source_id, external_key, generation) DO NOTHING
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.sourceId,
        input.externalKey,
        input.generation ?? 1,
        input.fingerprint,
        input.severity,
        input.sourceRevisionId ?? null,
        input.resolutionPolicy ?? "active_causal",
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return decodeIssueLoop(inserted);
    const existing = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND source_id = $2 AND external_key = $3 AND generation = $4`,
      [input.orgId, input.sourceId, input.externalKey, input.generation ?? 1],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new IssueLoopNotFoundError(input.externalKey);
    return decodeIssueLoop(row);
  },

  async get(client: QueryClient, orgId: string, projectId: string, loopId: string): Promise<IssueLoopRow | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [orgId, projectId, loopId],
    );
    return result.rows[0] === undefined ? undefined : decodeIssueLoop(result.rows[0]);
  },

  async getById(client: QueryClient, orgId: string, loopId: string): Promise<IssueLoopRow | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS} FROM issue_loops WHERE org_id = $1 AND id = $2`,
      [orgId, loopId],
    );
    return result.rows[0] === undefined ? undefined : decodeIssueLoop(result.rows[0]);
  },

  async listForProject(
    client: QueryClient,
    orgId: string,
    projectId: string,
    options?: { limit?: number },
  ): Promise<IssueLoopRow[]> {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [orgId, projectId, limit],
    );
    return result.rows.map((row) => decodeIssueLoop(row));
  },

  async appendFinding(client: QueryClient, input: AppendSourceFindingInput): Promise<SourceFindingRow> {
    const id = `sfind_${randomUUID()}`;
    const result = await client.query<RawSourceFindingRow>(
      `INSERT INTO source_findings
         (org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
          provider_revision, delivery_id, status, release, environment, title, body,
          context, fingerprint, observed_at, raw_artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
       RETURNING ${SOURCE_FINDING_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.issueLoopId,
        input.sourceId,
        input.providerObjectId,
        input.providerRevision,
        input.deliveryId ?? null,
        input.status,
        input.release ?? null,
        input.environment ?? null,
        input.title,
        input.body ?? "",
        JSON.stringify(input.context ?? {}),
        input.fingerprint,
        input.observedAt,
        input.rawArtifactRef ?? null,
      ],
    );
    return decodeSourceFinding(result.rows[0]!);
  },

  async appendFindingIfAbsent(
    client: QueryClient,
    input: AppendSourceFindingInput,
  ): Promise<AppendSourceFindingResult> {
    const id = `sfind_${randomUUID()}`;
    const result = await client.query<RawSourceFindingRow>(
      `INSERT INTO source_findings
         (org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
          provider_revision, delivery_id, status, release, environment, title, body,
          context, fingerprint, observed_at, raw_artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
       ON CONFLICT (org_id, source_id, provider_object_id, provider_revision) DO NOTHING
       RETURNING ${SOURCE_FINDING_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.issueLoopId,
        input.sourceId,
        input.providerObjectId,
        input.providerRevision,
        input.deliveryId ?? null,
        input.status,
        input.release ?? null,
        input.environment ?? null,
        input.title,
        input.body ?? "",
        JSON.stringify(input.context ?? {}),
        input.fingerprint,
        input.observedAt,
        input.rawArtifactRef ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return { finding: decodeSourceFinding(inserted), inserted: true };
    const existing = await client.query<RawSourceFindingRow>(
      `SELECT ${SOURCE_FINDING_COLUMNS}
         FROM source_findings
        WHERE org_id = $1 AND source_id = $2 AND provider_object_id = $3 AND provider_revision = $4`,
      [input.orgId, input.sourceId, input.providerObjectId, input.providerRevision],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error("source finding disappeared after idempotent conflict");
    return { finding: decodeSourceFinding(row), inserted: false };
  },

  async transition(
    client: QueryClient,
    input: TransitionIssueLoopInput,
  ): Promise<TransitionIssueLoopResult | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `UPDATE issue_loops
          SET state = $4, row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3
          AND state <> $4
          AND ($5::text IS NULL OR state = $5)
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [input.orgId, input.projectId, input.issueLoopId, input.toState, input.fromState ?? null],
    );
    const changed = result.rows[0];
    if (changed !== undefined) return { loop: decodeIssueLoop(changed), changed: true };
    const current = await IssueLoopStore.get(client, input.orgId, input.projectId, input.issueLoopId);
    return current === undefined ? undefined : { loop: current, changed: false };
  },

  async markSourceSyncVerified(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<TransitionIssueLoopResult | undefined> {
    return IssueLoopStore.transition(client, {
      orgId,
      projectId,
      issueLoopId,
      toState: "verified_closed",
      fromState: "verified_source_sync_pending",
    });
  },

  async markExternallyClosedUnverified(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<TransitionIssueLoopResult | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `UPDATE issue_loops
          SET state = 'externally_closed_unverified', row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state <> 'verified_closed'
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [orgId, projectId, issueLoopId],
    );
    const changed = result.rows[0];
    if (changed !== undefined) return { loop: decodeIssueLoop(changed), changed: true };
    const current = await IssueLoopStore.get(client, orgId, projectId, issueLoopId);
    return current === undefined ? undefined : { loop: current, changed: false };
  },

  async listFindings(client: QueryClient, orgId: string, loopId: string): Promise<SourceFindingRow[]> {
    const result = await client.query<RawSourceFindingRow>(
      `SELECT ${SOURCE_FINDING_COLUMNS}
         FROM source_findings
        WHERE org_id = $1 AND issue_loop_id = $2
        ORDER BY observed_at ASC, id ASC`,
      [orgId, loopId],
    );
    return result.rows.map(decodeSourceFinding);
  },

  async linkEdge(client: QueryClient, input: LinkIssueLoopEdgeInput): Promise<void> {
    await client.query(
      `INSERT INTO issue_loop_edges (org_id, project_id, issue_loop_id, related_issue_loop_id, relation)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, project_id, issue_loop_id, related_issue_loop_id, relation) DO NOTHING`,
      [input.orgId, input.projectId, input.issueLoopId, input.relatedIssueLoopId, input.relation],
    );
  },
} as const;
