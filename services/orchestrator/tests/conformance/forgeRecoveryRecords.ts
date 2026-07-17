// Record shapes + the shared in-memory store for the forge/recovery conformance
// harness (forgeRecoveryMemoryDb.ts drives the per-org ScopedClient over this).
// Split out so the SQL-matching client file stays under the 500-line cap. Every
// tenant record carries an `org_id` the ScopedClient filters on (the RLS
// visibility gate); the SQL the stores emit selects only the real columns.

export interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

export interface SpecRec {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  metadata: unknown;
  org_id: string;
  // Insertion order proxy for the bounded grounding list's recency sort (§7.5).
  // Defaults to a monotonic insertion index when a fixture omits it.
  created_at?: number;
}
export interface RunRec {
  run_id: string;
  spec_id: string;
  project_id: string;
  status: string;
  outcome: string | null;
  org_id: string;
}
export interface TaskRec {
  task_id: string;
  run_id: string;
  started_at: Date | null;
  org_id: string;
}
export interface EventRec {
  id: number;
  ts: Date;
  run_id: string | null;
  event_type: string;
  payload: unknown;
  org_id: string;
}
export interface CostRec {
  id: number;
  run_id: string;
  project_id: string;
  cost_usd: string | null;
  recorded_at: Date;
  org_id: string;
}
export interface ProjectRec {
  project_id: string;
  repo_url: string;
  // `projects.default_branch` is `NOT NULL DEFAULT 'main'`; optional here so
  // existing seeds keep the column's default, set it to exercise a non-`main` repo.
  default_branch?: string;
  runner_image: string;
  config: unknown;
  org_id: string | null;
}
export interface MemberRec {
  project_id: string;
  user_id: string;
  role: string;
  org_id: string;
}
export interface PersonaRec {
  id: string;
  scope: string;
  project_id: string | null;
  org_id: string;
}
export interface BehaviorRec {
  id: string;
  persona_id: string;
  title: string;
  org_id: string;
}
export interface InboxSourceRec {
  id: string;
  org_id: string;
  project_id: string | null;
  kind: string;
  name: string;
  detail: string;
  config: unknown;
  enabled: string;
  auto_route: string;
  created_at: Date;
}
export interface CandidateRec {
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
  // Insertion-order proxy for the `ORDER BY created_at DESC` / `updated_at ASC`
  // candidate reads (a monotonic counter the fixture stamps on insert).
  seq: number;
  updated_seq: number;
}
export interface WebhookEventRec {
  id: string;
  source_id: string;
  org_id: string;
  event_type: string;
  delivery_id: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  // bh-3 intake-hardening columns (provider + canonical hash + signature metadata).
  provider: string | null;
  canonical_payload_hash: string | null;
  signature_algo: string | null;
  signature_key_version: string | null;
  delivery_signed_at: string | null;
  claim_owner: string | null;
  claim_expires_at: string | null;
  // Insertion-order proxy for the sweeper's `ORDER BY created_at ASC` read.
  seq: number;
}
export interface AuditJobRec {
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
  created_at: Date;
}

export class ForgeRecoveryDb {
  specs: SpecRec[] = [];
  runs: RunRec[] = [];
  tasks: TaskRec[] = [];
  events: EventRec[] = [];
  costRecords: CostRec[] = [];
  projects: ProjectRec[] = [];
  members: MemberRec[] = [];
  personas: PersonaRec[] = [];
  behaviors: BehaviorRec[] = [];
  inboxSources: InboxSourceRec[] = [];
  candidates: CandidateRec[] = [];
  webhookEvents: WebhookEventRec[] = [];
  auditJobs: AuditJobRec[] = [];
  // Monotonic insert/update counter for the candidate + webhook-event recency sorts.
  seq = 0;
}

// The candidates RETURNING/SELECT projection — the candidate columns plus the
// joined `source_name`/`source_kind` the store maps (the `candidates JOIN
// inbox_sources` shape). The source is looked up from the shared store.
export function candidateCols(c: CandidateRec, sources: InboxSourceRec[]): Record<string, unknown> {
  const src = sources.find((s) => s.id === c.source_id);
  return {
    id: c.id,
    source_id: c.source_id,
    org_id: c.org_id,
    project_id: c.project_id,
    external_id: c.external_id,
    title: c.title,
    body: c.body,
    severity: c.severity,
    status: c.status,
    triage: c.triage,
    resolved_spec_id: c.resolved_spec_id,
    source_name: src?.name ?? "",
    source_kind: src?.kind ?? "manual",
  };
}

// The webhook_events RETURNING/SELECT projection — the real columns the store maps.
export function webhookEventCols(e: WebhookEventRec): Record<string, unknown> {
  return {
    id: e.id,
    source_id: e.source_id,
    org_id: e.org_id,
    event_type: e.event_type,
    delivery_id: e.delivery_id,
    payload: e.payload,
    status: e.status,
    attempts: e.attempts,
    last_error: e.last_error,
    provider: e.provider,
    claim_owner: e.claim_owner,
    claim_expires_at: e.claim_expires_at,
    canonical_payload_hash: e.canonical_payload_hash,
    signature_algo: e.signature_algo,
    signature_key_version: e.signature_key_version,
    delivery_signed_at: e.delivery_signed_at,
  };
}

// The audit_jobs RETURNING/SELECT projection — the real columns the store maps.
export function auditCols(j: AuditJobRec): Record<string, unknown> {
  return {
    id: j.id,
    org_id: j.org_id,
    project_id: j.project_id,
    kind: j.kind,
    name: j.name,
    cadence: j.cadence,
    target_window: j.target_window,
    answerer_cli: j.answerer_cli,
    enabled: j.enabled,
    last_run: j.last_run,
    findings: j.findings,
  };
}
