// Test pool for the project-progress route. Covers the SQL shapes the
// aggregate folds: assertProjectAccess (projects.org_id + project_members),
// ProjectStore.get, projectSpecs.listForProject (the status-bearing spec
// SELECT), fetchRunListItems (the run-list projection), and fetchFeedPage (the
// project activity feed). Matched by SQL prefix, the same approach as the
// RoutesPool / RunRoutesPool helpers; unmatched queries return empty so
// unrelated paths (e.g. insights) never crash a test.

import type pg from "pg";

interface QueryResult<R = unknown> {
  rows: R[];
  rowCount: number;
}

const DEFAULT_ORG_ID = "org_acme";

interface ProjectRow {
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  allocator: string;
  config: unknown;
  org_id: string | null;
}

interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
  priority: string;
}

interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  org_id: string;
  trigger: string;
  branch: string;
  status: string;
  outcome: string | null;
  pr_url: string | null;
  started_at: Date;
  ended_at: Date | null;
}

interface EventRow {
  id: number;
  ts: Date;
  run_id: string | null;
  task_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  org_id: string;
  event_type: string;
  payload: unknown;
}

export class ProgressRoutesPool {
  readonly projects = new Map<string, ProjectRow>();
  readonly projectMembers = new Set<string>();
  readonly specs: SpecRow[] = [];
  readonly runs: RunRow[] = [];
  readonly events: EventRow[] = [];

  seedProject(input: Partial<ProjectRow> & { project_id: string; org_id: string | null }): void {
    this.projects.set(input.project_id, {
      project_id: input.project_id,
      name: input.name ?? "Project",
      repo_url: input.repo_url ?? "https://github.com/example/repo",
      default_branch: input.default_branch ?? "main",
      runner_image: input.runner_image ?? "ghcr.io/example/runner:v0",
      allocator: input.allocator ?? "local-docker",
      config: input.config ?? { version: 1 },
      org_id: input.org_id,
    });
  }

  seedProjectMember(projectId: string, userId: string): void {
    this.projectMembers.add(`${projectId}:${userId}`);
  }

  seedSpec(input: Partial<SpecRow> & { spec_id: string; project_id: string }): void {
    this.specs.push({
      spec_id: input.spec_id,
      project_id: input.project_id,
      title: input.title ?? "Spec",
      description: input.description ?? "spec description",
      acceptance_criteria: input.acceptance_criteria ?? ["criterion"],
      depends_on: input.depends_on ?? [],
      status: input.status ?? "pending",
      priority: input.priority ?? "tbd",
    });
  }

  seedRun(input: Partial<RunRow> & { run_id: string; spec_id: string; project_id: string }): void {
    this.runs.push({
      run_id: input.run_id,
      spec_id: input.spec_id,
      project_id: input.project_id,
      org_id: input.org_id ?? this.projects.get(input.project_id)?.org_id ?? DEFAULT_ORG_ID,
      trigger: input.trigger ?? "cli",
      branch: input.branch ?? "main",
      status: input.status ?? "running",
      outcome: input.outcome ?? null,
      pr_url: input.pr_url ?? null,
      started_at: input.started_at ?? new Date("2026-05-01T00:00:00.000Z"),
      ended_at: input.ended_at ?? null,
    });
  }

  seedEvent(input: Partial<EventRow> & { id: number; event_type: string }): void {
    this.events.push({
      id: input.id,
      ts: input.ts ?? new Date(2026, 4, 1, 0, 0, input.id),
      run_id: input.run_id ?? null,
      task_id: input.task_id ?? null,
      spec_id: input.spec_id ?? null,
      project_id: input.project_id ?? null,
      org_id:
        input.org_id ??
        (input.project_id === undefined ? undefined : (this.projects.get(input.project_id)?.org_id ?? undefined)) ??
        DEFAULT_ORG_ID,
      event_type: input.event_type,
      payload: input.payload ?? {},
    });
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }

    // assertProjectAccess: project org + membership.
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: project.org_id }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const ok = this.projectMembers.has(`${String(params[0])}:${String(params[1])}`);
      return ok ? { rows: [{ role: "member" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // ProjectStore.get (project meta + org_id tenant check).
    if (trimmed.startsWith("SELECT project_id, name, repo_url, default_branch, runner_image, allocator, config")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined ? { rows: [], rowCount: 0 } : { rows: [project], rowCount: 1 };
    }

    // projectSpecs.listForProject (the status-bearing spec SELECT, ORDER BY title).
    if (trimmed.startsWith("SELECT spec_id, project_id, title, description, acceptance_criteria, depends_on, status")) {
      const rows = this.specs
        .filter((s) => s.project_id === String(params[0]))
        .sort((a, b) => a.title.localeCompare(b.title));
      return { rows, rowCount: rows.length };
    }

    // fetchRunListItems: the run-list projection (project_id + org_id, newest-first).
    if (trimmed.startsWith("SELECT") && /FROM runs r/u.test(trimmed)) {
      const projectId = String(params[0]);
      const orgId = String(params[1]);
      const rows = this.runs
        .filter((r) => r.project_id === projectId && r.org_id === orgId)
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime() || a.run_id.localeCompare(b.run_id))
        .map((r) => ({
          run_id: r.run_id,
          spec_id: r.spec_id,
          project_id: r.project_id,
          trigger: r.trigger,
          branch: r.branch,
          status: r.status,
          outcome: r.outcome,
          pr_url: r.pr_url,
          started_at: r.started_at,
          ended_at: r.ended_at,
          spec_title: this.specs.find((s) => s.spec_id === r.spec_id)?.title ?? null,
          cost_total_usd: "0",
          last_event_at:
            this.events
              .filter((e) => e.run_id === r.run_id)
              .map((e) => e.ts)
              .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
        }));
      return { rows, rowCount: rows.length };
    }

    // fetchFeedPage: project activity feed (project_id = $1 AND org_id = $2 AND run_id IS NOT NULL).
    if (/FROM events\s+WHERE project_id = \$1 AND org_id = \$2 AND run_id IS NOT NULL/u.test(trimmed)) {
      const orgId = String(params[1]);
      const limit = Number(params.at(-1));
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 5) {
        cursorTs = params[2] as Date;
        cursorId = Number(params[3]);
      }
      const rows = this.events
        .filter((e) => e.project_id === String(params[0]) && e.org_id === orgId && e.run_id !== null)
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.ts.getTime() < cursorTs.getTime()) return true;
          if (e.ts.getTime() === cursorTs.getTime()) return e.id < cursorId;
          return false;
        })
        .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // fetchCompletionBlockingSpecIds: unbounded merge signal projection.
    if (trimmed.startsWith("WITH signal_events AS (")) {
      const projectId = String(params[0]);
      const orgId = String(params[1]);
      const decided = new Set<string>();
      const blocked = new Set<string>();
      const events = this.events
        .filter((e) => e.project_id === projectId && e.org_id === orgId)
        .filter((e) => isMergeCompletionSignal(e))
        .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id);
      for (const event of events) {
        const ids = attributedSpecIds(event, this.runs);
        if (event.event_type === "merge.completed") {
          for (const id of ids) decided.add(id);
          continue;
        }
        for (const id of ids) {
          if (decided.has(id)) continue;
          decided.add(id);
          blocked.add(id);
        }
      }
      const rows = [...blocked].sort().map((spec_id) => ({ spec_id }));
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<ProgressRoutesPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

function isMergeCompletionSignal(event: EventRow): boolean {
  if (event.event_type === "merge.completed") return true;
  const payload = payloadRecord(event);
  if (!isNativeQueueOrLegacyPayload(payload)) return false;
  if (event.event_type === "merge.queue.infra_blocked") return true;
  if (event.event_type === "merge.batch.infra_blocked") return payload["terminal"] === true;
  if (event.event_type === "merge.dequeued") return payload["reason"] === "blocked" || payload["reason"] === "failed";
  return false;
}

function isNativeQueueOrLegacyPayload(payload: Record<string, unknown>): boolean {
  const integration = payload["integration"];
  return integration === undefined || integration === "native_queue";
}

function attributedSpecIds(event: EventRow, runs: ReadonlyArray<RunRow>): string[] {
  const ids: string[] = [];
  const payload = payloadRecord(event);
  appendSpecId(ids, payload["specId"]);
  appendMemberSpecIds(ids, payload["members"]);
  if (event.event_type !== "merge.batch.infra_blocked" || ids.length === 0) {
    appendSpecId(ids, event.spec_id);
  }
  if (ids.length === 0) {
    appendSpecId(ids, runs.find((run) => run.run_id === event.run_id)?.spec_id);
  }
  return [...new Set(ids)];
}

function appendMemberSpecIds(ids: string[], members: unknown): void {
  if (!Array.isArray(members)) return;
  for (const member of members) {
    if (member === null || typeof member !== "object") continue;
    appendSpecId(ids, (member as Record<string, unknown>)["specId"]);
  }
}

function appendSpecId(ids: string[], value: unknown): void {
  if (typeof value === "string" && value !== "") ids.push(value);
}

function payloadRecord(event: EventRow): Record<string, unknown> {
  if (event.payload === null || typeof event.payload !== "object") return {};
  return event.payload as Record<string, unknown>;
}
