// candidate-inbox store: the `inbox_sources` + `candidates` (collapsed baseline
// 0000) member of the `Repositories` seam. Pure SQL + row mapping; no Forge or
// GitHub here. The engine (forge/inbox/engine.ts) composes this with the
// connectors + the triage answerer.
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
import { z } from "zod";
import {
  Candidate,
  CandidateTriage,
  InboxSource,
  SourceKind,
  parsePersistedInboxSourceConfig,
  type CandidateStatus,
  type IngestedItem,
} from "../forge/inbox/types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;
interface ManagedSourceQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

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
  state?: string;
  attention_code?: string | null;
  attention_message?: string | null;
  attention_observed_at?: Date | string | null;
  webhook_configured?: boolean;
  retry_not_before?: Date | string | null;
  project_valid?: boolean;
}

const SourceRowSchema = z
  .object({
    id: z.string(),
    org_id: z.string(),
    project_id: z.string().nullable(),
    kind: z.string(),
    name: z.string(),
    detail: z.string(),
    config: z.record(z.string(), z.unknown()).nullable(),
    enabled: z.string(),
    auto_route: z.string(),
    state: z.string().optional(),
    attention_code: z.string().nullable().optional(),
    attention_message: z.string().nullable().optional(),
    attention_observed_at: z.union([z.date(), z.string()]).nullable().optional(),
    webhook_configured: z.boolean().optional(),
    retry_not_before: z.union([z.date(), z.string()]).nullable().optional(),
    project_valid: z.boolean().optional(),
  })
  .strict();

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
  if (row.project_valid === false) throw new InboxSourceProjectScopeError();
  const kind = SourceKind.parse(row.kind);
  const state = row.state ?? "active";
  const config =
    row.config === null && state === "needs_attention" ? null : parsePersistedInboxSourceConfig(kind, row.config ?? {});
  const observedAt = isoOrNull(row.attention_observed_at);
  const attention =
    row.attention_code === undefined ||
    row.attention_code === null ||
    row.attention_message == null ||
    observedAt === null
      ? null
      : { code: row.attention_code, message: row.attention_message, observedAt };
  return InboxSource.parse({
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind,
    name: row.name,
    detail: row.detail,
    config,
    enabled: row.enabled === "true",
    autoRoute: row.auto_route === "true",
    state,
    attention,
    retryNotBefore: isoOrNull(row.retry_not_before),
    webhookConfigured: row.webhook_configured ?? false,
  });
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
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
    sourceKind: SourceKind.parse(row.source_kind ?? "manual"),
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

export class InboxSourceProjectScopeError extends Error {
  constructor() {
    super("inbox source project does not belong to its organization");
    this.name = "InboxSourceProjectScopeError";
  }
}

export class InboxSourceUnavailableError extends Error {
  constructor() {
    super("inbox source is disabled or needs attention");
    this.name = "InboxSourceUnavailableError";
  }
}

export class InboxCandidateLineageError extends Error {
  constructor() {
    super("candidate org/project lineage does not match its inbox source");
    this.name = "InboxCandidateLineageError";
  }
}

export interface InboxSourceReadFailure {
  id: string;
  orgId: string;
  projectId: string | null;
}

export class InboxSourceDecodeError extends Error {
  readonly source: InboxSourceReadFailure;

  constructor(row: SourceRow) {
    super("persisted inbox source config is not canonical");
    this.name = "InboxSourceDecodeError";
    this.source = {
      id: row.id,
      orgId: row.org_id,
      projectId: row.project_valid === false ? null : row.project_id,
    };
  }
}

const SOURCE_COLUMNS = `id, org_id, project_id, kind, name, detail, config, enabled, auto_route,
  state, attention_code, attention_message, attention_observed_at,
  (webhook_secret_ref IS NOT NULL) AS webhook_configured, retry_not_before`;

// The candidate-inbox data-access seam: the `inbox_sources` + `candidates`
// reads/writes behind a value object for the `Repositories` registry. Methods
// take the caller's `QueryClient` (a pool OR a `runWithOrgScope`/
// `runWithSystemScope` client); the seam does not open transactions or widen
// scope.
export const InboxStore = {
  async createSource(client: QueryClient, input: CreateSourceInput): Promise<InboxSource> {
    const id = `src_${randomUUID()}`;
    const config = parsePersistedInboxSourceConfig(input.kind, input.config ?? {});
    const result = await client.query<SourceRow>(
      `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, detail, config, enabled, auto_route)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
        WHERE $3::text IS NULL
           OR EXISTS (SELECT 1 FROM projects WHERE project_id = $3 AND org_id = $2)
       RETURNING ${SOURCE_COLUMNS}`,
      [
        id,
        input.orgId,
        input.projectId,
        input.kind,
        input.name,
        input.detail ?? "",
        JSON.stringify(config),
        input.enabled === false ? "false" : "true",
        input.autoRoute === true ? "true" : "false",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new InboxSourceProjectScopeError();
    return mapSource(row);
  },

  /** Idempotent provisioner-owned source write through the same config/project authority. */
  async upsertManagedSource(
    client: ManagedSourceQueryClient,
    input: Omit<CreateSourceInput, "projectId"> & { projectId: string },
  ): Promise<InboxSource> {
    const id = `src_${randomUUID()}`;
    const config = parsePersistedInboxSourceConfig(input.kind, input.config ?? {});
    const result = await client.query(
      `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, detail, config, enabled, auto_route)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
         FROM projects
        WHERE project_id = $3 AND org_id = $2
       ON CONFLICT (org_id, project_id, kind) WHERE (config->>'managedBy') = 'integration-provisioner'
       DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, enabled = EXCLUDED.enabled,
                     updated_at = now()
       RETURNING ${SOURCE_COLUMNS}`,
      [
        id,
        input.orgId,
        input.projectId,
        input.kind,
        input.name,
        input.detail ?? "",
        JSON.stringify(config),
        input.enabled === false ? "false" : "true",
        input.autoRoute === true ? "true" : "false",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new InboxSourceProjectScopeError();
    return mapSource(SourceRowSchema.parse(row));
  },

  async listSources(client: QueryClient, orgId: string): Promise<InboxSource[]> {
    const result = await client.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS},
              (project_id IS NULL OR EXISTS (
                SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
              )) AS project_valid
       FROM inbox_sources WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return result.rows.map(mapSource);
  },

  /** Row-isolated decode so one hostile legacy config cannot starve peer sources. */
  async listSourcesForIntake(
    client: QueryClient,
    orgId: string,
  ): Promise<{ sources: InboxSource[]; invalid: InboxSourceReadFailure[] }> {
    const result = await client.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS},
              (project_id IS NULL OR EXISTS (
                SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
              )) AS project_valid
       FROM inbox_sources WHERE org_id = $1 AND enabled = 'true' AND state = 'active' ORDER BY created_at`,
      [orgId],
    );
    const sources: InboxSource[] = [];
    const invalid: InboxSourceReadFailure[] = [];
    for (const row of result.rows) {
      try {
        sources.push(mapSource(row));
      } catch {
        invalid.push({
          id: row.id,
          orgId: row.org_id,
          projectId: row.project_valid === false ? null : row.project_id,
        });
      }
    }
    return { sources, invalid };
  },

  async getSource(client: QueryClient, sourceId: string): Promise<InboxSource | undefined> {
    const result = await client.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS},
              (project_id IS NULL OR EXISTS (
                SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
              )) AS project_valid
       FROM inbox_sources WHERE id = $1`,
      [sourceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSource(row);
  },

  /** Fresh, exact-tenant validation immediately before intake side effects. */
  async getSourceForIntake(client: QueryClient, sourceId: string, orgId: string): Promise<InboxSource | undefined> {
    const result = await client.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS},
              (project_id IS NULL OR EXISTS (
                SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
              )) AS project_valid
       FROM inbox_sources WHERE id = $1 AND org_id = $2`,
      [sourceId, orgId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    let source: InboxSource;
    try {
      source = mapSource(row);
    } catch {
      throw new InboxSourceDecodeError(row);
    }
    if (!source.enabled || source.state !== "active") throw new InboxSourceUnavailableError();
    return source;
  },

  /** Internal webhook coordinate write; never mutates or returns provider config. */
  async setWebhookSecretRef(
    client: QueryClient,
    sourceId: string,
    orgId: string,
    webhookSecretRef: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE inbox_sources SET webhook_secret_ref = $3, updated_at = now()
        WHERE id = $1 AND org_id = $2 AND kind = 'issues' AND state = 'active'
          AND enabled = 'true'`,
      [sourceId, orgId, webhookSecretRef],
    );
    return result.rowCount === 1;
  },

  /** Internal webhook coordinate read immediately before SecretStore access. */
  async getWebhookSecretRef(client: QueryClient, sourceId: string, orgId: string): Promise<string | undefined> {
    const result = await client.query<{ webhook_secret_ref: string }>(
      `SELECT webhook_secret_ref FROM inbox_sources
        WHERE id = $1 AND org_id = $2 AND kind = 'issues' AND state = 'active'
          AND enabled = 'true' AND webhook_secret_ref IS NOT NULL
          AND (project_id IS NULL OR EXISTS (
            SELECT 1 FROM projects p WHERE p.project_id = inbox_sources.project_id AND p.org_id = inbox_sources.org_id
          ))`,
      [sourceId, orgId],
    );
    return result.rows[0]?.webhook_secret_ref;
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
       SELECT $1, s.id, s.org_id, $4, $5, $6, $7, $8, $9, $10::jsonb
         FROM inbox_sources s
        WHERE s.id = $2 AND s.org_id = $3 AND s.enabled = 'true' AND s.state = 'active'
          AND (s.project_id IS NULL OR s.project_id = $4)
          AND ($4::text IS NULL OR EXISTS (
            SELECT 1 FROM projects p WHERE p.project_id = $4 AND p.org_id = s.org_id
          ))
       ON CONFLICT (org_id, source_id, external_id) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         severity = EXCLUDED.severity,
         triage = EXCLUDED.triage,
         status = CASE WHEN candidates.status IN ('new','triaged','auto_routed')
                       THEN EXCLUDED.status ELSE candidates.status END,
         updated_at = now()
       WHERE candidates.org_id = EXCLUDED.org_id
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
    const row = result.rows[0];
    if (row === undefined) throw new InboxCandidateLineageError();
    return mapCandidate(row);
  },

  async listCandidates(client: QueryClient, orgId: string): Promise<Candidate[]> {
    const result = await client.query<CandidateRow>(
      `SELECT c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
              c.severity, c.status, c.triage, c.resolved_spec_id,
              s.name AS source_name, s.kind AS source_kind
       FROM candidates c JOIN inbox_sources s ON s.id = c.source_id AND s.org_id = c.org_id
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
       FROM candidates c JOIN inbox_sources s ON s.id = c.source_id AND s.org_id = c.org_id
       WHERE c.id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCandidate(row);
  },

  // Place a project-less candidate into a resolved project. The intake
  // project-placement resolver calls this when a routable feature request arrived
  // with no `project_id` (org-scoped source) and the org has exactly ONE project —
  // so the candidate becomes auto-routable instead of stalling in the inbox. The
  // join + RLS bound the row to the caller's org; a no-op returns undefined.
  async placeCandidateProject(
    client: QueryClient,
    candidateId: string,
    projectId: string,
  ): Promise<Candidate | undefined> {
    const result = await client.query<CandidateRow>(
      `UPDATE candidates c SET project_id = $2, updated_at = now()
       FROM inbox_sources s, projects p
       WHERE c.id = $1 AND s.id = c.source_id AND s.org_id = c.org_id
         AND p.project_id = $2 AND p.org_id = c.org_id
         AND (s.project_id IS NULL OR s.project_id = $2)
       RETURNING c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
                 c.severity, c.status, c.triage, c.resolved_spec_id,
                 s.name AS source_name, s.kind AS source_kind`,
      [candidateId, projectId],
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
       FROM inbox_sources s WHERE c.id = $1 AND s.id = c.source_id AND s.org_id = c.org_id
         AND ($3::text IS NULL OR EXISTS (
           SELECT 1 FROM specs sp WHERE sp.spec_id = $3 AND sp.org_id = c.org_id
         ))
       RETURNING c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
                 c.severity, c.status, c.triage, c.resolved_spec_id,
                 s.name AS source_name, s.kind AS source_kind`,
      [candidateId, status, resolvedSpecId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapCandidate(row);
  },

  // §3.6 stuck-candidate sweep: candidates left `auto_routed` with NO resolved
  // spec — the triage verdict said auto-route but the DAG commit never landed (an
  // LLM timeout / DB blip after the upsert but before `autoRouteCandidate`
  // resolved). These are re-drivable: the sweeper re-runs the auto-route, which is
  // idempotent on (source, externalId). Org-scoped under RLS by the caller's client.
  async listStuckAutoRouted(client: QueryClient, limit: number): Promise<Candidate[]> {
    const result = await client.query<CandidateRow>(
      `SELECT c.id, c.source_id, c.org_id, c.project_id, c.external_id, c.title, c.body,
              c.severity, c.status, c.triage, c.resolved_spec_id,
              s.name AS source_name, s.kind AS source_kind
       FROM candidates c JOIN inbox_sources s ON s.id = c.source_id AND s.org_id = c.org_id
       WHERE c.status = 'auto_routed' AND c.resolved_spec_id IS NULL
       ORDER BY c.updated_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapCandidate);
  },

  // Every org that owns an enabled inbox source — the system-scoped fan-out the
  // cross-org poller reads before listing each org's due sources. The DISTINCT +
  // `enabled = 'true'` predicate are byte-identical to the inline poller read.
  async listDistinctEnabledSourceOrgIds(client: QueryClient): Promise<string[]> {
    const result = await client.query<{ org_id: string }>(
      "SELECT DISTINCT org_id FROM inbox_sources WHERE enabled = 'true' AND state = 'active'",
    );
    return result.rows.map((r) => r.org_id);
  },
} as const;
