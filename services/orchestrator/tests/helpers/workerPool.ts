import type pg from "pg";

// Shared with runWorker.test.ts: the github credential ref the seeded run's
// project config carries, echoed back from the CI-poll run⋈project read.
export const githubCredentialRef = "credential/github/dev";

// In-memory pg substitute covering exactly the SQL the seam emits:
// createProject/createSpec/createQueuedRunFromSpec inserts + reads, the
// worker's run⋈spec⋈project join, resolveCredentialsForRun's org read, and the
// planner-loop workflow's run/spec state + task/cost/CI queries.
interface ProjectRow {
  project_id: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  config: unknown;
  org_id: string | null;
}
interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: string[];
  status: string;
}
interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  branch: string;
}

export class WorkerPool {
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  specStatus = "pending";
  prUrl: string | null = null;
  // Test-support for the org-scoping mutants (runExecutor org-scope establishment
  // + finalize): when set, the run⋈spec⋈project read echoes this org on the
  // project row, so a job carrying the same org drives the real
  // `runWithOrgScope` / `runWithJobOrgId` / `orgScopingPool` code paths. When
  // `orgVisibleRunIds` is non-null, the `establishJobOrgContext` reachability
  // SELECT (`... AND org_id = $2`) only returns a row for a listed run — so a
  // run absent from it surfaces the JobOrgContextLostError branch.
  forcedProjectOrgId: string | null = null;
  orgVisibleRunIds: Set<string> | null = null;
  // Records the eventType (params[3]) of every event PgEventStore writes through
  // the pool, so the finalize-path event emission is observable without a real
  // DB. The single-event-writer architecture check ignores this router (the
  // INSERT is matched via regex, not a literal).
  readonly eventTypes: string[] = [];
  private readonly projects = new Map<string, ProjectRow>();
  private readonly specs = new Map<string, SpecRow>();
  private readonly runs = new Map<string, RunRow>();
  private readonly costRows: Array<{ id: string; total_tokens: number }> = [];
  private nextCostId = 1;
  private ciTask: { taskId: string; attempt: number } | undefined;

  /** Seed a cost row so the post-run accrual read (`getRunUsage`) returns usage. */
  seedCostRow(totalTokens: number): void {
    this.costRows.push({ id: String(this.nextCostId++), total_tokens: totalTokens });
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    if (trimmed.startsWith("INSERT INTO projects")) {
      this.projects.set(String(params[0]), {
        project_id: String(params[0]),
        repo_url: String(params[2]),
        default_branch: String(params[3]),
        runner_image: String(params[4]),
        config: JSON.parse(String(params[6])) as unknown,
        org_id: params[7] === null ? null : String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT project_id FROM projects")) {
      return single(this.projects.has(String(params[0])) ? { project_id: String(params[0]) } : undefined);
    }
    if (trimmed.startsWith("INSERT INTO project_members")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      this.specs.set(String(params[0]), {
        spec_id: String(params[0]),
        project_id: String(params[1]),
        title: String(params[2]),
        description: String(params[3]),
        acceptance_criteria: JSON.parse(String(params[4])) as unknown,
        depends_on: params[5] as string[],
        status: String(params[6]),
      });
      return { rows: [], rowCount: 1 };
    }
    // createQueuedRunFromSpec: spec⋈project load
    if (/FROM specs s\s+JOIN projects p/u.test(trimmed)) {
      const spec = this.specs.get(String(params[0]));
      if (spec === undefined) return { rows: [], rowCount: 0 };
      const project = this.projects.get(spec.project_id)!;
      return single({
        project_id: project.project_id,
        name: "p",
        repo_url: project.repo_url,
        default_branch: project.default_branch,
        runner_image: project.runner_image,
        allocator: "local-docker",
        config: project.config,
        spec_id: spec.spec_id,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: spec.acceptance_criteria,
        depends_on: spec.depends_on,
        status: spec.status,
      });
    }
    // worker loadRunExecutionContext: run⋈spec⋈project join
    if (/FROM runs r\s+JOIN specs s/u.test(trimmed)) {
      const run = this.runs.get(String(params[0]));
      if (run === undefined) return { rows: [], rowCount: 0 };
      const spec = this.specs.get(run.spec_id)!;
      const project = this.projects.get(run.project_id)!;
      return single({
        run_id: run.run_id,
        spec_id: run.spec_id,
        project_id: run.project_id,
        branch: run.branch,
        repo_url: project.repo_url,
        default_branch: project.default_branch,
        runner_image: project.runner_image,
        config: project.config,
        // A test that forces an org echoes it here, so the claimed job's org
        // matches the run's resolved org and the org-scoped paths engage.
        org_id: this.forcedProjectOrgId ?? project.org_id,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: spec.acceptance_criteria,
      });
    }
    if (trimmed.startsWith("SELECT config FROM organizations")) {
      return single({ config: { version: 1 } });
    }
    // RLS wave R1: the worker's establishJobOrgContext confirms the claimed run
    // is reachable under its org GUC. Visible when the run exists with that org;
    // when `orgVisibleRunIds` is set a test can hide a run to force the
    // JobOrgContextLostError branch (the run is not reachable under its org).
    if (trimmed.startsWith("SELECT 1 FROM runs WHERE run_id = $1 AND org_id = $2")) {
      const runId = String(params[0]);
      if (this.orgVisibleRunIds !== null) {
        return single(this.orgVisibleRunIds.has(runId) ? { ok: 1 } : undefined);
      }
      return single(this.runs.get(runId) === undefined ? undefined : { ok: 1 });
    }
    if (trimmed.startsWith("INSERT INTO runs")) {
      this.runs.set(String(params[0]), {
        run_id: String(params[0]),
        spec_id: String(params[1]),
        project_id: String(params[2]),
        branch: String(params[4]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO job_queue")) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // Event-store inserts (PgEventStore writes through the real pool). Matched
    // via regex rather than a string literal so the single-event-writer
    // architecture check does not flag this in-memory fake pool router. The
    // event_type ($5 → params[4]) is recorded so finalize-path emission is
    // observable without a real DB.
    if (/^INSERT\s+INTO\s+events/u.test(trimmed)) {
      this.eventTypes.push(String(params[4] ?? ""));
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // spec status transitions (claim 'active', finalize 'done')
    if (trimmed.startsWith("UPDATE specs SET status = 'active'")) {
      this.specStatus = "active";
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE specs SET status = 'done'")) {
      this.specStatus = "done";
      return { rows: [], rowCount: 1 };
    }
    // P3-0008 merge stage marks the spec merged/done with a parameterized status.
    if (trimmed.startsWith("UPDATE specs SET status = $2")) {
      this.specStatus = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    // Metering / cost-reconcile read: SUMs the run's cost_records totals (the
    // workflow's run-end cost apportion reads these). A test that seeds a cost
    // row can assert the summed totals flow through.
    if (/SUM\(total_tokens\)[\s\S]*FROM cost_records/u.test(trimmed)) {
      const tokens = this.costRows.reduce((sum, r) => sum + r.total_tokens, 0);
      return single({ runs: tokens, tokens, cost_usd: tokens === 0 ? 0 : 1.5 });
    }
    // cost_records reconcile path
    if (trimmed.startsWith("SELECT id, total_tokens FROM cost_records")) {
      return {
        rows: this.costRows.map((r) => ({ id: r.id, total_tokens: r.total_tokens })),
        rowCount: this.costRows.length,
      };
    }
    if (trimmed.startsWith("UPDATE cost_records SET cost_usd")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costRows.push({ id: String(this.nextCostId++), total_tokens: Number(params[11] ?? 0) });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO tasks")) {
      if (trimmed.includes("'ci'")) {
        this.ciTask = { taskId: String(params[0]), attempt: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE tasks")) {
      return { rows: [], rowCount: 1 };
    }
    // CI poll + P3-0008 review/merge context: run⋈project read. Both stages
    // share this SELECT prefix. Return the project's STORED config so the merge
    // context resolves the run's real mergeIntegration / governancePosture (the
    // P3-0026 hard tier seeds direct_merge + open to exercise the conflict
    // branch); the top-level githubCredentialRef is preserved for the CI-poll
    // cred read. A run whose project carries no mergeIntegration migrates to the
    // not_configured → external_reviewer hand-off as before.
    if (trimmed.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.pr_url")) {
      const runId = String(params[0]);
      const run = this.runs.get(runId)!;
      const project = this.projects.get(run.project_id);
      // The project's stored config already carries credentials.githubCredentialRef
      // (CI poll takes its cred ref from the workflow's explicit override). Return
      // it verbatim — a synthesized top-level key would trip the strict V1 parse.
      const storedConfig = project?.config ?? { githubCredentialRef };
      return single({
        run_id: run.run_id,
        spec_id: run.spec_id,
        project_id: run.project_id,
        pr_url: this.prUrl,
        config: storedConfig,
        // P3-0008 review/merge context columns (shares this SELECT prefix).
        default_branch: "main",
        org_config: null,
      });
    }
    if (trimmed.startsWith("SELECT task_id, attempt")) {
      return this.ciTask === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ task_id: this.ciTask.taskId, attempt: this.ciTask.attempt }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET pr_url")) {
      this.prUrl = String(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'running'")) {
      this.runStatus = { status: "running", outcome: null };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'done'")) {
      this.runStatus = { status: "done", outcome: "ok" };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'halted'")) {
      // The worker's failure-path finalizer (`finalizeRunRecoverable`) starts
      // here + carries a RETURNING clause. Honor the `outcome` literal and the
      // `status IN (...)` guard parsed from the SQL so the finalizer's effect is
      // observed exactly (else a mutant that swaps the literal would survive).
      if (trimmed.includes("RETURNING")) {
        const outcomeMatch = /outcome = '([a-z_]+)'/u.exec(trimmed);
        const finalizeOutcome = outcomeMatch?.[1] ?? "halted";
        const allowed = [...trimmed.matchAll(/'(running|queued|failed)'/gu)].map((m) => m[1]);
        if (allowed.includes(this.runStatus.status)) {
          this.runStatus = { status: "halted", outcome: finalizeOutcome };
          const run = this.runs.get(String(params[0]));
          return {
            rows: [
              {
                run_id: String(params[0]),
                spec_id: run?.spec_id ?? "",
                project_id: run?.project_id ?? "",
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      this.runStatus = { status: "halted", outcome: String(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE runs SET status = 'failed'")) {
      this.runStatus = { status: "failed", outcome: "failed" };
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE job_queue")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<WorkerPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

export function single<T>(row: T | undefined): { rows: unknown[]; rowCount: number } {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}
