// candidate-inbox store: the `inbox_sources` + `candidates` (migration
// 0024) member of the `Repositories` seam. Pure SQL + row mapping; no Forge or
// GitHub here. The engine (engine.ts) composes this with the connectors + the
// triage answerer.
//
// This is a seam member like the other migrated forge stores (discovery /
// recovery / forge-tools): the SQL lives behind the `InboxStore` value object,
// callers depend on the store method (`InboxStore.x` / `repos.inbox.x`) rather
// than a standalone function, and there is no parallel raw-SQL path. Every method
// runs on the client the caller hands in (the org-scope carrier), so under RLS an
// org-scoped client sees only that org's rows and an off-scope client sees zero —
// byte-identical to the inline `.query` sites this seam carries through.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  Candidate,
  CandidateTriage,
  InboxSource,
  type CandidateStatus,
  type IngestedItem,
  type SourceKind,
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface SourceRow {
  id: string;
  org_id: string;
  project_id: string | null;
  kind: string;
  name: string;
  detail: string;
  config: Record<string, unknown> | null;
  enabled: string;
  auto_route: string;
}

interface CandidateRow {
  id: string;
  source_id: string;
  org_id: string;
  project_id: string | null;
  external_id: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  triage: unknown;
  resolved_spec_id: string | null;
  source_name: string | null;
  source_kind: string | null;
}

function mapSource(row: SourceRow): InboxSource {
  return InboxSource.parse({
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    detail: row.detail,
    config: row.config ?? {},
    enabled: row.enabled === "true",
    autoRoute: row.auto_route === "true",
  });
}

function mapCandidate(row: CandidateRow): Candidate {
  const triageRaw = row.triage;
  const hasTriage = triageRaw !== null && typeof triageRaw === "object" && Object.keys(triageRaw).length > 0;
  return Candidate.parse({
    id: row.id,
    sourceId: row.source_id,
    orgId: row.org_id,
    projectId: row.project_id,
    externalId: row.external_id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    triage: hasTriage ? CandidateTriage.parse(triageRaw) : null,
    resolvedSpecId: row.resolved_spec_id,
    sourceName: row.source_name ?? "",
    sourceKind: (row.source_kind ?? "manual") as SourceKind,
  });
}

export interface CreateSourceInput {
  orgId: string;
  projectId: string | null;
  kind: SourceKind;
  name: string;
  detail?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  autoRoute?: boolean;
}

// The candidate-inbox data-access seam: the `inbox_sources` + `candidates`
// reads/writes behind a value object for the `Repositories` registry. Methods
// take the caller's `QueryClient` (a pool OR a `runWithOrgScope`/
// `runWithSystemScope` client); the seam does not open transactions or widen
// scope.
export const InboxStore = {
  async createSource(client: QueryClient, input: CreateSourceInput): Promise<InboxSource> {
    const id = `src_${randomUUID()}`;
    const result = await client.query<SourceRow>(
      `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, detail, config, enabled, auto_route)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING id, org_id, project_id, kind, name, detail, config, enabled, auto_route`,
      [
        id,
        input.orgId,
        input.projectId,
        input.kind,
        input.name,
        input.detail ?? "",
        JSON.stringify(input.config ?? {}),
        input.enabled === false ? "false" : "true",
        input.autoRoute === true ? "true" : "false",
      ],
    );
    return mapSource(result.rows[0]!);
  },

  async listSources(client: QueryClient, orgId: string): Promise<InboxSource[]> {
    const result = await client.query<SourceRow>(
      `SELECT id, org_id, project_id, kind, name, detail, config, enabled, auto_route
       FROM inbox_sources WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return result.rows.map(mapSource);
  },

  async getSource(client: QueryClient, sourceId: string): Promise<InboxSource | undefined> {
    const result = await client.query<SourceRow>(
      `SELECT id, org_id, project_id, kind, name, detail, config, enabled, auto_route
       FROM inbox_sources WHERE id = $1`,
      [sourceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSource(row);
  },

  // Replace a source's `config` jsonb (the webhook-provision path stamps a
  // `webhookSecretRef` here — no migration; the secret REF lives in the config blob).
  async updateSourceConfig(
    client: QueryClient,
    sourceId: string,
    config: Record<string, unknown>,
  ): Promise<InboxSource | undefined> {
    const result = await client.query<SourceRow>(
      `UPDATE inbox_sources SET config = $2::jsonb, updated_at = now() WHERE id = $1
       RETURNING id, org_id, project_id, kind, name, detail, config, enabled, auto_route`,
      [sourceId, JSON.stringify(config)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSource(row);
  },

  // Idempotent upsert keyed by (source_id, external_id): re-polling the same
  // issue updates title/body/severity but never duplicates the candidate. A
  // already-resolved candidate keeps its status (we only refresh content/triage
  // on rows still `new`/`triaged`).
  async upsertCandidate(
    client: QueryClient,
    source: InboxSource,
    item: IngestedItem,
    triage: CandidateTriage | null,
    status: CandidateStatus,
  ): Promise<Candidate> {
    const id = `cand_${randomUUID()}`;
    const result = await client.query<CandidateRow>(
      `INSERT INTO candidates
         (id, source_id, org_id, project_id, external_id, title, body, severity, status, triage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (source_id, external_id) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         severity = EXCLUDED.severity,
         triage = EXCLUDED.triage,
         status = CASE WHEN candidates.status IN ('new','triaged','auto_routed')
                       THEN EXCLUDED.status ELSE candidates.status END,
         updated_at = now()
       RETURNING id, source_id, org_id, project_id, external_id, title, body, severity, status,
                 triage, resolved_spec_id,
                 $11::text AS source_name, $12::text AS source_kind`,
      [
        id,
        source.id,
        source.orgId,
        item.projectId,
        item.externalId,
        item.title,
        item.body,
        item.severity,
        status,
        triage === null ? "{}" : JSON.stringify(triage),
        source.name,
        source.kind,
      ],
    );
    return mapCandidate(result.rows[0]!);
  },

  async listCandidates(client: QueryClient, orgId: string): Promise<Candidate[]> {
    const result = await client.query<CandidateRow>(
      `SELECT c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
              c.severity, c.status, c.triage, c.resolved_spec_id,
              s.name AS source_name, s.kind AS source_kind
       FROM candidates c JOIN inbox_sources s ON s.id = c.source_id
       WHERE c.org_id = $1 ORDER BY c.created_at DESC`,
      [orgId],
    );
    return result.rows.map(mapCandidate);
  },

  async getCandidate(client: QueryClient, candidateId: string): Promise<Candidate | undefined> {
    const result = await client.query<CandidateRow>(
      `SELECT c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
              c.severity, c.status, c.triage, c.resolved_spec_id,
              s.name AS source_name, s.kind AS source_kind
       FROM candidates c JOIN inbox_sources s ON s.id = c.source_id
       WHERE c.id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCandidate(row);
  },

  // Resolve a candidate to a terminal status; `resolvedSpecId` is set on accept.
  async resolveCandidate(
    client: QueryClient,
    candidateId: string,
    status: CandidateStatus,
    resolvedSpecId: string | null,
  ): Promise<Candidate | undefined> {
    const result = await client.query<CandidateRow>(
      `UPDATE candidates c SET status = $2, resolved_spec_id = $3, updated_at = now()
       FROM inbox_sources s WHERE c.id = $1 AND s.id = c.source_id
       RETURNING c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
                 c.severity, c.status, c.triage, c.resolved_spec_id,
                 s.name AS source_name, s.kind AS source_kind`,
      [candidateId, status, resolvedSpecId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCandidate(row);
  },

  // Every org that owns an enabled inbox source — the system-scoped fan-out the
  // cross-org poller reads before listing each org's due sources. The DISTINCT +
  // `enabled = 'true'` predicate are byte-identical to the inline poller read.
  async listDistinctEnabledSourceOrgIds(client: QueryClient): Promise<string[]> {
    const result = await client.query<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM inbox_sources WHERE enabled = 'true'",
    );
    return result.rows.map((r) => r.org_id);
  },
} as const;
