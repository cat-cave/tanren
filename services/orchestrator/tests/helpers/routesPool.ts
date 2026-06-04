// Tiny in-memory pg substitute that covers the SQL shapes used by the
// P2A-0013 route layer (orgs, projects, specs, doctor, brownfield link) plus the
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
  /** Per-project cost-record rows (only `project_id` + `cost_usd` are summed). */
  readonly costRecords: Array<{ project_id: string; cost_usd: number }> = [];

  seedCostRecord(projectId: string, costUsd: number): void {
    this.costRecords.push({ project_id: projectId, cost_usd: costUsd });
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
      const total = this.costRecords.filter((r) => r.project_id === projectId).reduce((sum, r) => sum + r.cost_usd, 0);
      return { rows: [{ total: String(total) }], rowCount: 1 };
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
      this.seedSpec({
        spec_id: String(params[0]),
        project_id: String(params[1]),
        title: String(params[2]),
        description: String(params[3]),
        acceptance_criteria: JSON.parse(String(params[4])) as unknown,
        depends_on: params[5] as string[],
        status: String(params[6]),
        priority: String(params[7]),
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
