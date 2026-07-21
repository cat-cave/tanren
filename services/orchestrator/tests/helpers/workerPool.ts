import type pg from "pg";

// Shared with runWorker.test.ts: the github credential ref the seeded run's
// project config carries, echoed back from the CI-poll run⋈project read.
export const githubCredentialRef = "credential/github/org/org_worker_seed/dev";

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
  lifecycle: string;
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
  priority: string;
}
interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  branch: string;
}

export class WorkerPool {
  // Pool surface for `isPool` (must not key on `connect` alone — PoolClient has it).
  readonly totalCount = 0;
  runStatus: { status: string; outcome: string | null } = { status: "queued", outcome: null };
  specStatus = "pending";
  // The orphan-strand SUCCESSOR-run probe (`SELECT 1 FROM runs WHERE spec_id = $1 ...`):
  // >0 ⇒ a re-drive's freshly-queued successor exists ⇒ the spec is transitioning, not
  // orphaned. Defaults to 0 (no successor → a genuine orphan strands).
  successorRunCount = 0;
  // The orphan path's consecutive-same-failure read (`SELECT payload FROM events ...
  // dag.spec.redriven`): the prior re-driven failure codes newest→oldest. The orphan
  // re-drives under the cap (spec → `open`) and genuine-halts at it. Defaults to empty
  // (first failure of its kind ⇒ re-drive).
  priorRedrivenFailureCodes: string[] = [];
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
  // gv-11 / #25: DECLARED repo visibility for the run-admission `getProject` readback.
  declaredRepoVisibility: "public" | "private" | null = null;
  // Records the eventType (params[3]) of every event PgEventStore writes through
  // the pool, so the finalize-path event emission is observable without a real
  // DB. The single-event-writer architecture check ignores this router (the
  // INSERT is matched via regex, not a literal).
  readonly eventTypes: string[] = [];
  // The full (eventType, payload) of every event the finalize path writes through
  // the pool, so a test can assert the PUBLIC payload that lands in the event row
  // — e.g. that `run.failed.message` carries a safe code/summary, never a raw
  // arbitrary error string. The payload is the JSON-stringified `$6` bind param.
  readonly events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  private readonly projects = new Map<string, ProjectRow>();
  private readonly specs = new Map<string, SpecRow>();
  private readonly runs = new Map<string, RunRow>();
  private readonly costRows: Array<{ id: string; total_tokens: number; billing_mode: string }> = [];
  private nextCostId = 1;
  private ciTask: { taskId: string; attempt: number } | undefined;

  /** Seed a cost row so the post-run accrual read (`getRunUsage`) returns usage. */
  seedCostRow(totalTokens: number, billingMode = "per_token"): void {
    this.costRows.push({ id: String(this.nextCostId++), total_tokens: totalTokens, billing_mode: billingMode });
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
        lifecycle: String(params[7]),
        org_id: params[8] === null ? null : String(params[8]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT project_id FROM projects")) {
      return single(this.projects.has(String(params[0])) ? { project_id: String(params[0]) } : undefined);
    }
    // gv-11 / #25: run-admission project readback (getProject, project_id=$2).
    if (trimmed.startsWith("SELECT repo_url, repo_visibility")) {
      const p = this.projects.get(String(params[1]));
      if (p === undefined) return { rows: [], rowCount: 0 };
      return single({ repo_url: p.repo_url, repo_visibility: this.declaredRepoVisibility });
    }
    // v68 fix: createSpec calls loadProjectOrgId to stamp the spec's NOT NULL org_id.
    if (trimmed.startsWith("SELECT org_id FROM projects")) {
      const project = this.projects.get(String(params[0]));
      return single(project === undefined ? undefined : { org_id: project.org_id ?? "org_fake" });
    }
    // PgBudgetGate.resolveBudget (§3 proof 6): read the project's org + raw
    // config in one shot. Codex critic #11: the gate now FAILS CLOSED on a
    // missing project row / null org_id, so the fixture must synthesize an
    // owner + config (unlimited-budget default via the seeded config) — else
    // every workflow drives to `budget_paused` here.
    if (trimmed.startsWith("SELECT org_id, config FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return single(
        project === undefined
          ? undefined
          : { org_id: this.forcedProjectOrgId ?? project.org_id ?? "org_fake", config: project.config },
      );
    }
    // PgBudgetGate.sumSpend: COALESCE(SUM(cost_usd)) org-scoped. This fixture
    // never seeds cost_records with a project ceiling; return zeros so the
    // walker's genuine-ceiling gate never trips inside the workflow tests.
    if (trimmed.startsWith("SELECT COALESCE(SUM(cost_usd")) {
      return { rows: [{ total: "0", notional: "0", unpriced: "0" }], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO project_members")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      // v68 fix: explicit org_id at $3; every subsequent column shifts by 1.
      this.specs.set(String(params[0]), {
        spec_id: String(params[0]),
        project_id: String(params[1]),
        title: String(params[3]),
        description: String(params[4]),
        acceptance_criteria: JSON.parse(String(params[5])) as unknown,
        depends_on: params[6] as string[],
        status: String(params[7]),
        priority: String(params[8]),
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
        // v68 fix: the loader now surfaces the NOT NULL org_id on both rows.
        project_org_id: project.org_id ?? "org_fake",
        spec_org_id: project.org_id ?? "org_fake",
        name: "p",
        repo_url: project.repo_url,
        default_branch: project.default_branch,
        runner_image: project.runner_image,
        allocator: "local-docker",
        config: project.config,
        lifecycle: project.lifecycle,
        spec_id: spec.spec_id,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: spec.acceptance_criteria,
        depends_on: spec.depends_on,
        status: spec.status,
        priority: spec.priority,
        // Task #86: `specs.mode` (NOT NULL, default `from_scratch`) is now non-optional in
        // the row schema. The fixture insert doesn't parameterize mode, so echo the DB default.
        mode: "from_scratch",
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
        // Task #86: `specs.mode` (NOT NULL, default `from_scratch`) is now non-optional in
        // the row schema. The fixture insert doesn't parameterize mode, so echo the DB default.
        mode: "from_scratch",
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
      // v68 fix: org_id at $4 shifts branch→$6 (params[5]).
      this.runs.set(String(params[0]), {
        run_id: String(params[0]),
        spec_id: String(params[1]),
        project_id: String(params[2]),
        branch: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO job_queue")) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO merge_queue_partitions")) {
      return {
        rows: [{ id: String(params[2]), scope_key: String(params[4]), mode: String(params[5]), generation: 0 }],
        rowCount: 1,
      };
    }
    // Event-store inserts (PgEventStore writes through the real pool). Matched
    // via regex rather than a string literal so the single-event-writer
    // architecture check does not flag this in-memory fake pool router. The
    // event_type ($5 → params[4]) is recorded so finalize-path emission is
    // observable without a real DB.
    if (/^INSERT\s+INTO\s+events/u.test(trimmed)) {
      // v68 fix: org_id at $5 shifts event_type→$6 (params[5]) + payload→$7 (params[6]).
      const eventType = String(params[5] ?? "");
      this.eventTypes.push(eventType);
      // params[6] ($7) is the payload bind — a JSON string (PgEventStore stringifies
      // before the `$7::jsonb` cast). Parse it so a test can assert the public payload.
      let payload: Record<string, unknown> = {};
      try {
        const raw = params[6];
        payload = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
      this.events.push({ eventType, payload });
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // Orphan-strand reads (`parkStrandedSpecInProcess`): the spec's current status +
    // the SUCCESSOR-run probe. `successorRunCount` lets a test simulate a re-drive's
    // freshly-queued successor (>0 ⇒ the spec is transitioning, not orphaned).
    if (trimmed.startsWith("SELECT status FROM specs WHERE spec_id = $1")) {
      return single({ status: this.specStatus });
    }
    if (trimmed.startsWith("SELECT 1 FROM runs WHERE spec_id = $1")) {
      const n = this.successorRunCount;
      return { rows: n > 0 ? [{}] : [], rowCount: n };
    }
    // The orphan path's consecutive-same-failure read: prior `dag.spec.redriven` events
    // (newest→oldest) the authority's cap keys off.
    if (trimmed.startsWith("SELECT payload FROM events") && trimmed.includes("dag.spec.redriven")) {
      return {
        // Each prior re-drive records the ENRICHED signature (code + the `run` stage it failed
        // in), matching the live orphan path so the detector keys on `code@stage`.
        rows: this.priorRedrivenFailureCodes.map((c) => ({ payload: { failureCode: c, stage: "run" } })),
        rowCount: this.priorRedrivenFailureCodes.length,
      };
    }
    // The in-process orphan disposition: a GUARDED `in_flight`/`review` → `open` (a
    // RE-DRIVE, under the cap) or → `needs_attention` (the persistent-failure escalation
    // at the cap) flip that RETURNS the row only when it moved (so the event fires only
    // for a genuinely-occupying spec). Observed so a test can assert the worker re-drove /
    // escalated — or, for the single-finalize invariant, that it did NOT (a
    // `WorkflowFinalizedError` skips `finalizeRunRecoverable` entirely).
    //
    // Task #48 (run/spec atomicity sweep): the in-process orphan path now uses the
    // shared `applyUpdateSpecWithEvent` applier which writes a PARAMETERIZED
    // `UPDATE specs SET status = $2 ... <> ALL($3::text[]) RETURNING spec_id` (the
    // negative-form guard, equivalent to the prior `status IN ('in_flight','review')`
    // positive form for the four-states-of-the-spec model). Match BOTH shapes so the
    // fake is stable across the migration.
    const orphanFlipLegacy =
      /^UPDATE specs SET status = '(open|needs_attention)'\s+WHERE spec_id = \$1 AND status IN \('in_flight', 'review'\)/u.exec(
        trimmed,
      );
    if (orphanFlipLegacy !== null) {
      const occupying = this.specStatus === "in_flight" || this.specStatus === "review";
      if (!occupying) return { rows: [], rowCount: 0 };
      this.specStatus = orphanFlipLegacy[1] ?? "needs_attention";
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    // Task #48 parameterized variant — the atomic seam's shape. `notFromStatuses`
    // (param $3 — a text array) carries the negative-form guard; the target status
    // rides $2 (the applier accepts `open` for re-drive, `needs_attention` for halt).
    if (
      trimmed.startsWith(
        "UPDATE specs SET status = $2 WHERE spec_id = $1 AND status <> ALL($3::text[]) RETURNING spec_id",
      )
    ) {
      const occupying = this.specStatus === "in_flight" || this.specStatus === "review";
      if (!occupying) return { rows: [], rowCount: 0 };
      const target = String(params[1]);
      this.specStatus = target;
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    // spec status transitions (claim 'in_flight', finalize 'merged')
    if (trimmed.startsWith("UPDATE specs SET status = 'in_flight'")) {
      this.specStatus = "in_flight";
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE specs SET status = 'merged'")) {
      this.specStatus = "merged";
      return { rows: [], rowCount: 1 };
    }
    // merge stage marks the spec merged with a parameterized status.
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
    // cost_records reconcile path (now selects billing_mode for the two-axis split).
    if (trimmed.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      return {
        rows: this.costRows.map((r) => ({ id: r.id, total_tokens: r.total_tokens, billing_mode: r.billing_mode })),
        rowCount: this.costRows.length,
      };
    }
    if (trimmed.startsWith("UPDATE cost_records SET")) {
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      // billing_mode is param 15 (1-based $15 → 0-based 14) after notional_cost_usd ($14).
      this.costRows.push({
        id: String(this.nextCostId++),
        total_tokens: Number(params[11] ?? 0),
        billing_mode: String(params[14] ?? "self_hosted"),
      });
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
    // CI poll + review/merge context: run⋈project read. Both stages
    // share this SELECT prefix. Return the project's STORED config so the merge
    // context resolves the run's real mergeIntegration / governancePosture (the
    // hard tier seeds native_queue + open to exercise the conflict
    // branch); the top-level githubCredentialRef is preserved for the CI-poll
    // cred read. A run whose project carries no mergeIntegration migrates to the
    // not_configured → external_reviewer hand-off as before.
    if (
      trimmed.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.pr_url") ||
      trimmed.startsWith("SELECT r.run_id, r.spec_id, r.project_id, r.org_id, r.pr_url")
    ) {
      const runId = String(params[0]);
      const run = this.runs.get(runId)!;
      const project = this.projects.get(run.project_id);
      const orgId = this.forcedProjectOrgId ?? project?.org_id ?? "org_fake";
      // The project's stored config already carries credentials.githubCredentialRef
      // (CI poll takes its cred ref from the workflow's explicit override). Return
      // it verbatim — a synthesized top-level key would trip the strict V1 parse.
      const storedConfig = project?.config ?? { githubCredentialRef };
      return single({
        run_id: run.run_id,
        spec_id: run.spec_id,
        project_id: run.project_id,
        // v68 fix: runs.org_id (NOT NULL) is surfaced on the review/merge context.
        org_id: orgId,
        project_org_id: orgId,
        spec_org_id: orgId,
        spec_project_id: run.project_id,
        pr_url: this.prUrl,
        branch: run.branch,
        config: storedConfig,
        // review/merge context columns (shares this SELECT prefix).
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
    if (trimmed.startsWith("UPDATE runs SET status = 'completed'")) {
      this.runStatus = { status: "completed", outcome: "ok" };
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
    // Task #48: the atomic `applyFinalizeRunWithEvent` writes a fully PARAMETERIZED
    // shape: `UPDATE runs SET status = $2, outcome = $3, ended_at = now() WHERE run_id = $1
    // AND status = ANY($4::text[]) RETURNING spec_id, project_id` (multi-line in the
    // applier source — `\s+` admits the inline newline/indentation). The status
    // target rides $2, the outcome rides $3, the allowed-from-statuses array rides $4.
    // Honors the SAME guard semantics as the literal shape above so the finalizer's
    // effect is observable identically across the seam migration.
    if (
      /^UPDATE runs SET status = \$2, outcome = \$3, ended_at = now\(\)\s+WHERE run_id = \$1 AND status = ANY\(\$4::text\[\]\)\s+RETURNING spec_id, project_id/u.test(
        trimmed,
      )
    ) {
      const allowed = (params[3] as string[] | undefined) ?? [];
      if (allowed.includes(this.runStatus.status)) {
        const targetStatus = String(params[1]);
        const targetOutcome = String(params[2]);
        this.runStatus = { status: targetStatus, outcome: targetOutcome };
        const run = this.runs.get(String(params[0]));
        return {
          rows: [{ spec_id: run?.spec_id ?? "", project_id: run?.project_id ?? "" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
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

  async connect(): Promise<pg.PoolClient> {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params ?? []),
      release: () => {},
    } as unknown as pg.PoolClient;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

export function single<T>(row: T | undefined): { rows: unknown[]; rowCount: number } {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}
