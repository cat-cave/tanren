// Drives the pg-backed `Repositories` seam (pgRepositories) through the shared
// conformance suite. The backing store is an in-memory `pg` query target that
// understands the small set of statements the project repository emits and —
// crucially — models RLS row visibility: a client scoped to org X (one that
// carried `SET LOCAL app.current_org_id = 'X'`) sees only org X's rows, so the
// suite's off-scope assertion (org B sees ZERO of org A's rows) exercises the
// same row-filter contract the real org-scoped transaction provides.
import { pgRepositories, type QueryClient } from "../../src/engine/contracts/repositories.js";
import { describeRepositoriesConformance, type SeedProject } from "./repositoriesConformance.js";

interface ProjectRecord {
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  allocator: string;
  config: unknown;
  org_id: string | null;
}

// In-memory store shared by every scoped client the harness hands out.
class MemoryDb {
  projects: ProjectRecord[] = [];

  seedProject(p: SeedProject): void {
    this.projects.push({
      project_id: p.projectId,
      name: p.name,
      repo_url: p.repoUrl,
      default_branch: p.defaultBranch,
      runner_image: p.runnerImage,
      allocator: p.allocator,
      config: p.config,
      org_id: p.orgId,
    });
  }
}

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

// A `pg`-shaped client bound to one org scope. Reads filter rows whose `org_id`
// does not match the scope (RLS); writes mutate the shared store but only for
// rows visible to this scope.
class ScopedClient {
  constructor(
    private readonly db: MemoryDb,
    private readonly orgId: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    // The repository emits multi-line SQL; collapse whitespace so the shape
    // matchers below are agnostic to formatting/indentation.
    const sql = rawSql.replace(/\s+/gu, " ").trim();
    const visible = (): ProjectRecord[] => this.db.projects.filter((p) => p.org_id === this.orgId);

    if (/UPDATE projects SET config/u.test(sql)) {
      const [config, projectId] = params as [string, string];
      const row = visible().find((p) => p.project_id === projectId);
      if (row !== undefined) row.config = JSON.parse(config);
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE projects SET repo_url/u.test(sql)) {
      const [repoUrl, projectId] = params as [string, string];
      const row = visible().find((p) => p.project_id === projectId);
      if (row !== undefined) row.repo_url = repoUrl;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT org_id, default_branch FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = visible().find((p) => p.project_id === projectId);
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: row.org_id, default_branch: row.default_branch }], rowCount: 1 };
    }
    if (/SELECT org_id FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = visible().find((p) => p.project_id === projectId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: row.org_id }], rowCount: 1 };
    }
    if (/SELECT config FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = visible().find((p) => p.project_id === projectId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config: row.config }], rowCount: 1 };
    }
    if (/FROM projects WHERE org_id = \$1/u.test(sql)) {
      const [orgId] = params as [string];
      const rows = visible().filter((p) => p.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (/FROM projects WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = visible().filter((p) => p.project_id === projectId);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`MemoryDb: unrecognized SQL in conformance harness: ${sql}`);
  }
}

describeRepositoriesConformance("pgRepositories (in-memory pg)", () => {
  const db = new MemoryDb();
  return {
    repositories: pgRepositories,
    seed: (data) => {
      data.projects.forEach((p) => db.seedProject(p));
    },
    clientForOrg: (orgId): QueryClient => new ScopedClient(db, orgId) as unknown as QueryClient,
  };
});
