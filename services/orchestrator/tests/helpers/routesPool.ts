// Tiny in-memory pg substitute that covers the SQL shapes used by the
// route layer (orgs, projects, specs, doctor, brownfield link) plus the
// per-project budget surface (ownership + config read-modify-write + cost sum).
// Deliberately scoped: only the SQL fragments the routes emit are handled.

import type pg from "pg";

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

interface OrgRow {
  id: string;
  kind: string;
  external_id: string;
  login: string;
  display_name: string;
  config: unknown;
}

interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
}

interface ProjectRow {
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  allocator: string;
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

export class RoutesPool {
  readonly orgs = new Map<string, OrgRow>();
  readonly orgMembers = new Map<string, OrgMemberRow>();
  readonly projects = new Map<string, ProjectRow>();
  readonly projectMembers = new Map<string, { project_id: string; user_id: string; role: string }>();
  readonly specs = new Map<string, SpecRow>();
  readonly events: Array<Record<string, unknown>> = [];
  readonly tasks: Array<Record<string, unknown>> = [];
  readonly jobs: Array<Record<string, unknown>> = [];
  readonly runs: Array<Record<string, unknown>> = [];
  /** Inbox sources (the repo-link auto-provisioned `issues` source lands here). */
  readonly inboxSources: Array<Record<string, unknown>> = [];
  /**
   * Per-project cost-record rows the budget-sum query reads. `cost_usd` is REAL
   * spend; `notional_cost_usd` is the API-equivalent value (defaults to the real
   * figure for a per-token row, where real == notional).
   */
  readonly costRecords: Array<{ project_id: string; cost_usd: number; notional_cost_usd: number }> = [];
  /** Captured NOTIFY statements (channel + payload) so a test can assert a re-walk wake. */
  readonly notifies: Array<{ channel: string; payload: string }> = [];

  seedCostRecord(projectId: string, costUsd: number, notionalCostUsd: number = costUsd): void {
    this.costRecords.push({ project_id: projectId, cost_usd: costUsd, notional_cost_usd: notionalCostUsd });
  }

  seedBudgetPause(input: { orgId: string; projectId: string; readyHeldBack: number; observedAt?: Date }): void {
    this.events.push({
      id: this.events.length + 1,
      ts: input.observedAt ?? new Date("2026-07-15T12:00:00.000Z"),
      run_id: null,
      task_id: null,
      spec_id: null,
      project_id: input.projectId,
      org_id: input.orgId,
      event_type: "dag.budget.paused",
      payload: {
        ceilingUsd: 50,
        spentUsd: 55,
        period: "total",
        readyHeldBack: input.readyHeldBack,
      },
    });
  }

  seedOrg(input: Partial<OrgRow> & { id: string }): OrgRow {
    const row: OrgRow = {
      id: input.id,
      kind: input.kind ?? "github_org",
      external_id: input.external_id ?? input.id,
      login: input.login ?? input.id,
      display_name: input.display_name ?? input.login ?? input.id,
      // Default to a bare versioned config: real org rows are bootstrapped with
      // `defaultOrgConfigV1()`, and the parsers now fail hard on an unversioned
      // row (the migration shim is deleted).
      config: input.config ?? { version: 1 },
    };
    this.orgs.set(row.id, row);
    return row;
  }

  seedMembership(orgId: string, userId: string, role: "admin" | "member" = "member"): void {
    this.orgMembers.set(`${orgId}:${userId}`, { org_id: orgId, user_id: userId, role });
  }

  seedProject(input: Partial<ProjectRow> & { project_id: string; org_id: string | null }): ProjectRow {
    const row: ProjectRow = {
      project_id: input.project_id,
      name: input.name ?? "Project",
      repo_url: input.repo_url ?? "https://github.com/example/repo",
      default_branch: input.default_branch ?? "main",
      runner_image: input.runner_image ?? "ghcr.io/example/runner:v0",
      allocator: input.allocator ?? "local-docker",
      // Bare versioned config by default (see seedOrg): unversioned rows now
      // fail hard.
      config: input.config ?? { version: 1 },
      lifecycle: input.lifecycle ?? "active",
      org_id: input.org_id,
    };
    this.projects.set(row.project_id, row);
    return row;
  }

  /** Seed a run row (only the fields the lifecycle-cascade test reads). */
  seedRun(input: { run_id: string; project_id: string; status: string }): void {
    this.runs.push({ run_id: input.run_id, project_id: input.project_id, status: input.status });
  }

  seedSpec(input: Partial<SpecRow> & { spec_id: string; project_id: string }): SpecRow {
    const row: SpecRow = {
      spec_id: input.spec_id,
      project_id: input.project_id,
      title: input.title ?? "Spec",
      description: input.description ?? "Spec description",
      acceptance_criteria: input.acceptance_criteria ?? ["criterion"],
      depends_on: input.depends_on ?? [],
      status: input.status ?? "pending",
      priority: input.priority ?? "tbd",
    };
    this.specs.set(row.spec_id, row);
    return row;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    // NOTIFY <channel>[, '<payload>'] — capture the re-walk wake (audit §3.7e) so a test
    // can assert raising a paused project's ceiling fires a `tanren_dag` notification.
    const notify = /^NOTIFY\s+(\w+)(?:\s*,\s*'([^']*)')?/u.exec(trimmed);
    if (notify !== null) {
      this.notifies.push({ channel: notify[1]!, payload: notify[2] ?? "" });
      return { rows: [], rowCount: 0 };
    }

    // organizations
    if (trimmed.startsWith("SELECT o.id, o.kind, o.login, o.display_name, m.role")) {
      const userId = String(params[0]);
      const rows = [...this.orgMembers.values()]
        .filter((m) => m.user_id === userId)
        .map((m) => {
          const org = this.orgs.get(m.org_id);
          return org === undefined ? undefined : { ...org, role: m.role };
        })
        .filter((row): row is OrgRow & { role: string } => row !== undefined);
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("SELECT id, kind, login, display_name, config FROM organizations")) {
      const org = this.orgs.get(String(params[0]));
      return single(org);
    }
    if (trimmed.startsWith("SELECT config FROM organizations WHERE id = $1")) {
      const org = this.orgs.get(String(params[0]));
      return single(org === undefined ? undefined : { config: org.config });
    }
    if (trimmed.startsWith("UPDATE organizations SET config")) {
      const org = this.orgs.get(String(params[1]));
      if (org === undefined) return { rows: [], rowCount: 0 };
      org.config = JSON.parse(String(params[0])) as unknown;
      return { rows: [{ id: org.id }], rowCount: 1 };
    }

    // org_members (the GitHub-App install/callback org-admin authorization read).
    if (trimmed.startsWith("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")) {
      const row = this.orgMembers.get(`${String(params[0])}:${String(params[1])}`);
      return single(row === undefined ? undefined : { role: row.role });
    }

    // projects
    if (trimmed.startsWith("SELECT project_id, name, repo_url, default_branch, runner_image, allocator, config")) {
      if (sql.includes("WHERE org_id = $1")) {
        const orgId = String(params[0]);
        const rows = [...this.projects.values()].filter((p) => p.org_id === orgId);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("WHERE project_id = $1")) {
        const row = this.projects.get(String(params[0]));
        return single(row);
      }
      // ProjectStore.findByRepoUrl (the idempotent greenfield-create probe). Matches on
      // the canonical repo URL ignoring a trailing `.git` on either side.
      if (sql.includes("regexp_replace(repo_url")) {
        const canonical = String(params[0]).replace(/\.git$/u, "");
        const row = [...this.projects.values()].find((p) => p.repo_url.replace(/\.git$/u, "") === canonical);
        return single(row);
      }
    }
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return single(project === undefined ? undefined : { org_id: project.org_id });
    }
    // ProjectStore.getOwnership (the budget-route ownership guard).
    if (trimmed.startsWith("SELECT org_id, default_branch FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return single(
        project === undefined ? undefined : { org_id: project.org_id, default_branch: project.default_branch },
      );
    }
    // PgBudgetGate: resolve the project's org + raw config in one read.
    if (trimmed.startsWith("SELECT org_id, config FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return single(project === undefined ? undefined : { org_id: project.org_id, config: project.config });
    }
    // ProjectStore.getConfig (the budget PUT read-modify-write + narration).
    if (trimmed.startsWith("SELECT config FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return single(project === undefined ? undefined : { config: project.config });
    }
    // PgBudgetGate.sumSpend: COALESCE(SUM(cost_usd)) for a project over the period.
    // The in-memory store carries no timestamps, so every seeded record counts —
    // the windowing (monthly vs. total) is exercised by the gate's unit tests.
    if (trimmed.startsWith("SELECT COALESCE(SUM(cost_usd")) {
      const projectId = String(params[0]);
      const mine = this.costRecords.filter((r) => r.project_id === projectId);
      const total = mine.reduce((sum, r) => sum + r.cost_usd, 0);
      const notional = mine.reduce((sum, r) => sum + r.notional_cost_usd, 0);
      return { rows: [{ total: String(total), notional: String(notional), unpriced: "0" }], rowCount: 1 };
    }
    // PgBudgetPauseObservationReader: latest project-level DagWalker pause proof.
    if (trimmed.startsWith("SELECT ts, payload") && trimmed.includes("event_type = 'dag.budget.paused'")) {
      const orgId = String(params[0]);
      const projectId = String(params[1]);
      const latest = this.events
        .filter(
          (event) =>
            event["org_id"] === orgId &&
            event["project_id"] === projectId &&
            event["event_type"] === "dag.budget.paused" &&
            event["run_id"] === null &&
            event["task_id"] === null &&
            event["spec_id"] === null,
        )
        .sort((a, b) => {
          const byTime = new Date(String(b["ts"])).getTime() - new Date(String(a["ts"])).getTime();
          return byTime === 0 ? Number(b["id"]) - Number(a["id"]) : byTime;
        })[0];
      return single(latest === undefined ? undefined : { ts: latest["ts"], payload: latest["payload"] });
    }
    if (trimmed.startsWith("INSERT INTO projects")) {
      this.seedProject({
        project_id: String(params[0]),
        name: String(params[1]),
        repo_url: String(params[2]),
        default_branch: String(params[3]),
        runner_image: String(params[4]),
        allocator: String(params[5]),
        config: JSON.parse(String(params[6])) as unknown,
        org_id: params[7] === null ? null : String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE projects SET config")) {
      const project = this.projects.get(String(params[1]));
      if (project === undefined) return { rows: [], rowCount: 0 };
      project.config = JSON.parse(String(params[0])) as unknown;
      return { rows: [{ project_id: project.project_id }], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE projects SET repo_url")) {
      const project = this.projects.get(String(params[1]));
      if (project === undefined) return { rows: [], rowCount: 0 };
      project.repo_url = String(params[0]);
      return { rows: [{ project_id: project.project_id }], rowCount: 1 };
    }
    // The lifecycle archive/unarchive flip ($1 = target, $2 = project id).
    if (trimmed.startsWith("UPDATE projects SET lifecycle")) {
      const project = this.projects.get(String(params[1]));
      if (project === undefined) return { rows: [], rowCount: 0 };
      project.lifecycle = String(params[0]);
      return { rows: [{ project_id: project.project_id }], rowCount: 1 };
    }
    // The archive cascade: cancel a project's in-flight (queued|running) runs
    // ($1 = project id). Flips matching rows to `cancelled` and returns their ids.
    if (trimmed.startsWith("UPDATE runs SET status = 'cancelled'")) {
      const projectId = String(params[0]);
      const cancelled = this.runs.filter(
        (r) => r["project_id"] === projectId && ["queued", "running"].includes(String(r["status"])),
      );
      for (const run of cancelled) {
        run["status"] = "cancelled";
        run["outcome"] = "cancelled";
      }
      return { rows: cancelled.map((r) => ({ run_id: r["run_id"] })), rowCount: cancelled.length };
    }
    if (trimmed.startsWith("INSERT INTO project_members")) {
      this.projectMembers.set(`${String(params[0])}:${String(params[1])}`, {
        project_id: String(params[0]),
        user_id: String(params[1]),
        role: String(params[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const row = this.projectMembers.get(`${String(params[0])}:${String(params[1])}`);
      return single(row === undefined ? undefined : { role: row.role });
    }
    if (trimmed.startsWith("SELECT project_id FROM projects")) {
      if (sql.includes("WHERE org_id = $1")) {
        const orgId = String(params[0]);
        const rows = [...this.projects.values()]
          .filter((project) => project.org_id === orgId)
          .map((project) => ({ project_id: project.project_id }));
        return { rows, rowCount: rows.length };
      }
      const project = this.projects.get(String(params[0]));
      return single(project === undefined ? undefined : { project_id: project.project_id });
    }

    // specs
    if (trimmed.startsWith("SELECT spec_id, project_id, title, description, acceptance_criteria, depends_on, status")) {
      if (sql.includes("WHERE project_id = $1")) {
        const rows = [...this.specs.values()].filter((s) => s.project_id === String(params[0]));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("WHERE spec_id = $1")) {
        const spec = this.specs.get(String(params[0]));
        return single(spec);
      }
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      // v68 fix: explicit org_id at $3; every subsequent column shifts by 1.
      this.seedSpec({
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
    if (trimmed.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      const projectId = String(params[0]);
      const ids = params[1] as string[];
      const rows = ids
        .map((id) => this.specs.get(id))
        .filter((s): s is SpecRow => s !== undefined && s.project_id === projectId)
        .map((s) => ({ spec_id: s.spec_id }));
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("UPDATE specs")) {
      const idx = trimmed.lastIndexOf("$");
      const last = Number(trimmed.slice(idx + 1).match(/^\d+/u)?.[0] ?? params.length);
      const specId = String(params[last - 1]);
      const spec = this.specs.get(specId);
      if (spec === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ spec_id: spec.spec_id }], rowCount: 1 };
    }

    if (trimmed.startsWith("INSERT INTO milestones")) {
      return {
        rows: [
          {
            id: params[0],
            project_id: params[1],
            label: params[2],
            name: params[3],
            description: params[4],
            order_index: params[5],
            eta: params[6],
            status: params[7],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith("DELETE FROM spec_milestones")) return { rows: [], rowCount: 0 };
    if (trimmed.startsWith("INSERT INTO spec_milestones")) return { rows: [], rowCount: 1 };

    // design_contracts (native design subsystem, WS-D1) — the derive persists the
    // captured design contract as a first-class version-1 row. Post-H2-unify
    // (migration 0028) params: [id, org_id, project_id, domain, contract_json].
    // The version is COALESCE'd in the real SQL; the stub returns version 1
    // (the first per-project contract).
    if (trimmed.startsWith("INSERT INTO design_contracts")) {
      return {
        rows: [
          {
            id: String(params[0]),
            org_id: String(params[1]),
            project_id: String(params[2]),
            version: 1,
            domain: String(params[3]),
            contract: JSON.parse(String(params[4])) as unknown,
          },
        ],
        rowCount: 1,
      };
    }

    // inbox_sources (the repo-link auto-provisioned `issues` source).
    if (trimmed.includes("FROM inbox_sources WHERE org_id = $1")) {
      const rows = this.inboxSources.filter((s) => s["org_id"] === String(params[0]));
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("INSERT INTO inbox_sources")) {
      const row = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: params[2] === null ? null : String(params[2]),
        kind: String(params[3]),
        name: String(params[4]),
        detail: String(params[5]),
        config: JSON.parse(String(params[6])) as unknown,
        enabled: String(params[7]),
        auto_route: String(params[8]),
      };
      this.inboxSources.push(row);
      return { rows: [row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<RoutesPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

function single<T>(row: T | undefined): QueryResult {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}
