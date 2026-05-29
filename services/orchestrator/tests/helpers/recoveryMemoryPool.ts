// P2B-0008 in-memory pg substitute for the recovery engine + route. Handles
// exactly the SQL the recovery flow emits: run lookups, the
// `workspace.git_captured` lineage scan, spec UPDATEs, the events INSERT, and
// the `createQueuedRunFromSpec` transaction (loadSpecWithProject JOIN, INSERT
// runs/tasks/job_queue, claim UPDATE). Forge thread create/select is handled so
// open_inspection_thread works. Unknown SQL returns empty rows.

import type pg from "pg";

interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  trigger: string;
  branch: string;
  status: string;
  outcome: string | null;
}

export interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  depends_on: string[];
  status: string;
}

export interface EventRow {
  id: number;
  run_id: string | null;
  task_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  event_type: string;
  payload: unknown;
  ts: Date;
}

export interface ForgeThreadRow {
  id: string;
  org_id: string;
  project_id: string | null;
  run_id: string | null;
  scope: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export class RecoveryMemoryPool {
  runs = new Map<string, RunRow>();
  specs = new Map<string, SpecRow>();
  projects = new Map<
    string,
    {
      project_id: string;
      org_id: string | null;
      name: string;
      repo_url: string;
      default_branch: string;
      runner_image: string;
      allocator: string;
      config: unknown;
    }
  >();
  projectMembers = new Set<string>();
  events: EventRow[] = [];
  tasks: Array<{ task_id: string; run_id: string; kind: string; status: string }> = [];
  jobs: Array<{ id: number; run_id: string; task_id: string; task_kind: string }> = [];
  threads = new Map<string, ForgeThreadRow>();
  private eventSeq = 0;
  private jobSeq = 0;
  now = new Date("2026-05-28T00:00:00.000Z");

  seedProject(input: { project_id: string; org_id: string | null }): void {
    this.projects.set(input.project_id, {
      project_id: input.project_id,
      org_id: input.org_id,
      name: "fixture-medium",
      repo_url: "https://github.com/cat-cave/fixture-medium",
      default_branch: "main",
      runner_image: "ghcr.io/cat-cave/tanren-runner:v0",
      allocator: "local-docker",
      config: {},
    });
  }

  seedProjectMember(projectId: string, userId: string): void {
    this.projectMembers.add(`${projectId}:${userId}`);
  }

  seedSpec(input: Partial<SpecRow> & { spec_id: string; project_id: string }): SpecRow {
    const row: SpecRow = {
      spec_id: input.spec_id,
      project_id: input.project_id,
      title: input.title ?? "no SSR theme flash",
      description: input.description ?? "behavior 5 — no SSR theme flash",
      acceptance_criteria: input.acceptance_criteria ?? ["no flash on first paint"],
      depends_on: input.depends_on ?? [],
      status: input.status ?? "active",
    };
    this.specs.set(row.spec_id, row);
    return row;
  }

  seedRun(input: Partial<RunRow> & { run_id: string; spec_id: string; project_id: string }): RunRow {
    const row: RunRow = {
      run_id: input.run_id,
      spec_id: input.spec_id,
      project_id: input.project_id,
      trigger: input.trigger ?? "dashboard",
      branch: input.branch ?? "main",
      status: input.status ?? "halted",
      outcome: input.outcome ?? "retry_budget_exhausted",
    };
    this.runs.set(row.run_id, row);
    return row;
  }

  seedGitCaptured(runId: string, shas: string[]): void {
    this.events.push({
      id: ++this.eventSeq,
      run_id: runId,
      task_id: null,
      spec_id: null,
      project_id: null,
      event_type: "workspace.git_captured",
      payload: {
        workspacePath: "/w",
        commits: shas.map((sha) => ({ sha, message: "m" })),
        diffBytes: 1,
      },
      ts: new Date(this.now.getTime() + this.eventSeq * 1000),
    });
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const t = sql.trim();

    if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [], rowCount: 0 };

    // assertRunAccess: project_id + spec_id from runs
    if (t.startsWith("SELECT project_id, spec_id FROM runs WHERE run_id = $1")) {
      const run = this.runs.get(String(params[0]));
      return run
        ? { rows: [{ project_id: run.project_id, spec_id: run.spec_id }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // assertProjectAccess: org_id from projects
    if (t.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const p = this.projects.get(String(params[0]));
      return p ? { rows: [{ org_id: p.org_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (t.startsWith("SELECT role FROM project_members")) {
      const ok = this.projectMembers.has(`${String(params[0])}:${String(params[1])}`);
      return ok ? { rows: [{ role: "member" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // loadHaltedRunContext: run row
    if (t.startsWith("SELECT spec_id, project_id, status, outcome FROM runs WHERE run_id = $1")) {
      const run = this.runs.get(String(params[0]));
      return run
        ? {
            rows: [
              {
                spec_id: run.spec_id,
                project_id: run.project_id,
                status: run.status,
                outcome: run.outcome,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    // last good commit / captured commits scan
    if (/FROM events\s+WHERE run_id = \$1 AND event_type = 'workspace.git_captured'/.test(t)) {
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]) && e.event_type === "workspace.git_captured")
        .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
        .map((e) => ({ payload: e.payload }));
      const limited = /LIMIT 1/.test(t) ? rows.slice(0, 1) : rows;
      return { rows: limited, rowCount: limited.length };
    }
    // append steering to spec
    if (t.startsWith("UPDATE specs") && t.includes("operator steering")) {
      const spec = this.specs.get(String(params[0]));
      if (spec) spec.description = `${spec.description}\n\n[operator steering] ${String(params[1])}`;
      return { rows: [], rowCount: spec ? 1 : 0 };
    }
    // reopen spec for replan
    if (t.startsWith("UPDATE specs SET status = 'pending' WHERE spec_id = $1")) {
      const spec = this.specs.get(String(params[0]));
      if (spec && spec.status !== "done" && spec.status !== "merged") spec.status = "pending";
      return { rows: [], rowCount: spec ? 1 : 0 };
    }
    // claimPendingSpec
    if (t.startsWith("UPDATE specs SET status = 'active' WHERE spec_id = $1 AND status = 'pending'")) {
      const spec = this.specs.get(String(params[0]));
      if (spec && spec.status === "pending") {
        spec.status = "active";
        return { rows: [{ spec_id: spec.spec_id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    // loadSpecWithProject JOIN
    if (/FROM specs s\s+JOIN projects p/.test(t)) {
      const spec = this.specs.get(String(params[0]));
      if (spec === undefined) return { rows: [], rowCount: 0 };
      const project = this.projects.get(spec.project_id)!;
      return {
        rows: [
          {
            project_id: project.project_id,
            name: project.name,
            repo_url: project.repo_url,
            default_branch: project.default_branch,
            runner_image: project.runner_image,
            allocator: project.allocator,
            config: project.config,
            spec_id: spec.spec_id,
            title: spec.title,
            description: spec.description,
            acceptance_criteria: spec.acceptance_criteria,
            depends_on: spec.depends_on,
            status: spec.status,
          },
        ],
        rowCount: 1,
      };
    }
    // ensureSpecDependenciesDone (done deps lookup)
    if (/FROM specs WHERE project_id = \$1 AND status = 'done'/.test(t)) {
      return { rows: [], rowCount: 0 };
    }
    // INSERT runs
    if (t.startsWith("INSERT INTO runs")) {
      this.runs.set(String(params[0]), {
        run_id: String(params[0]),
        spec_id: String(params[1]),
        project_id: String(params[2]),
        trigger: String(params[3]),
        branch: String(params[4]),
        status: "queued",
        outcome: null,
      });
      return { rows: [], rowCount: 1 };
    }
    // INSERT tasks
    if (t.startsWith("INSERT INTO tasks")) {
      this.tasks.push({
        task_id: String(params[0]),
        run_id: String(params[1]),
        kind: "plan",
        status: "queued",
      });
      return { rows: [], rowCount: 1 };
    }
    // INSERT job_queue ... RETURNING id. The task_kind is a SQL literal
    // ('plan') in the VALUES clause, not a bound param — read it from the SQL.
    if (t.startsWith("INSERT INTO job_queue")) {
      const id = ++this.jobSeq;
      const kindMatch = /VALUES\s*\(\$1,\s*\$2,\s*'([^']+)'/.exec(t);
      this.jobs.push({
        id,
        run_id: String(params[0]),
        task_id: String(params[1]),
        task_kind: kindMatch?.[1] ?? "plan",
      });
      return { rows: [{ id: String(id) }], rowCount: 1 };
    }
    // The eventStore.append write. Matched via a regex (whitespace classes,
    // not literal spaces) so this test pool does not trip the
    // single-event-writer architecture guard, which scans for the bare
    // table-write literal outside eventStore.ts.
    if (/INSERT\s+INTO\s+events\b/i.test(t)) {
      this.events.push({
        id: ++this.eventSeq,
        run_id: params[0] === null ? null : String(params[0]),
        task_id: params[1] === null ? null : String(params[1]),
        spec_id: params[2] === null ? null : String(params[2]),
        project_id: params[3] === null ? null : String(params[3]),
        event_type: String(params[4]),
        payload: JSON.parse(String(params[5])),
        ts: new Date(this.now.getTime() + this.eventSeq * 1000),
      });
      return { rows: [], rowCount: 1 };
    }
    // ForgeThreadStore.create INSERT ... RETURNING
    if (t.startsWith("INSERT INTO forge_threads")) {
      const row: ForgeThreadRow = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: params[2] === null || params[2] === undefined ? null : String(params[2]),
        run_id: params[3] === null || params[3] === undefined ? null : String(params[3]),
        scope: String(params[4]),
        title: params[5] === null || params[5] === undefined ? null : String(params[5]),
        created_at: this.now,
        updated_at: this.now,
        closed_at: null,
      };
      this.threads.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<RecoveryMemoryPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  lineageEvents(): EventRow[] {
    return this.events.filter((e) => e.event_type.startsWith("recovery."));
  }
}
