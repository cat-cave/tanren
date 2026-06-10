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
  auditJobs: AuditJobRec[] = [];
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
