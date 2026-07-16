// Drives the pg-backed `Repositories` seam (pgRepositories) through the shared
// conformance suite. The backing store is an in-memory `pg` query target that
// understands the small set of statements the repositories emit and — crucially
// — models RLS row visibility: a client scoped to org X (one that carried `SET
// LOCAL app.current_org_id = 'X'`) sees only org X's rows, so the suite's
// off-scope assertions (org B sees ZERO of org A's rows) exercise the same
// row-filter contract the real org-scoped transaction provides. Tables without a
// literal org_id column (behaviors, milestones, spec_dependencies) carry an
// org tag in the harness purely to model that visibility gate; the SQL the
// stores emit selects only the real columns. The record shapes + seeding live in
// `conformanceMemoryDb.ts`; the run-domain read SQL in `conformanceRunSql.ts`.
import { pgRepositories, type QueryClient } from "../../src/engine/contracts/repositories.js";
import {
  MemoryDb,
  type BehaviorRecord,
  type MilestoneRecord,
  type PersonaRecord,
  type ProjectRecord,
  type QueryResult,
  type SpecDependencyRecord,
  type SpecRecord,
} from "./conformanceMemoryDb.js";
import { handleRunReadSql } from "./conformanceRunSql.js";
import type { SeedData } from "./conformanceFixtures.js";
import { describeRepositoriesConformance } from "./repositoriesConformance.js";

// A `pg`-shaped client bound to one org scope. Reads filter rows whose `org_id`
// does not match the scope (RLS); writes mutate the shared store but only for
// rows visible to this scope. Product-entity SQL is handled inline; the
// run-domain read SQL delegates to `handleRunReadSql`.
class ScopedClient {
  constructor(
    private readonly db: MemoryDb,
    private readonly orgId: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    // The repository emits multi-line SQL; collapse whitespace so the shape
    // matchers below are agnostic to formatting/indentation.
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const productResult = this.handleProductSql(sql, params);
    if (productResult !== undefined) return productResult;
    const runResult = handleRunReadSql(this.db, this.orgId, sql, params);
    if (runResult !== undefined) return runResult;
    throw new Error(`MemoryDb: unrecognized SQL in conformance harness: ${sql}`);
  }

  private handleProductSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    const projects = (): ProjectRecord[] => this.db.projects.filter((p) => p.org_id === this.orgId);
    const specs = (): SpecRecord[] => this.db.specs.filter((s) => s.org_id === this.orgId);
    const personas = (): PersonaRecord[] => this.db.personas.filter((p) => p.org_id === this.orgId);
    const behaviors = (): BehaviorRecord[] => this.db.behaviors.filter((b) => b.org_id === this.orgId);
    const milestones = (): MilestoneRecord[] => this.db.milestones.filter((m) => m.org_id === this.orgId);
    const specDeps = (): SpecDependencyRecord[] => this.db.specDependencies.filter((d) => d.org_id === this.orgId);

    // --- projects ---
    if (/UPDATE projects\s+SET config = \$1::jsonb,\s*config_revision = config_revision \+ 1/u.test(sql)) {
      const [config, projectId, expected] = params as [string, string, string];
      const row = projects().find((p) => p.project_id === projectId);
      if (row === undefined || row.config_revision !== Number(expected)) {
        return { rows: [], rowCount: 0 };
      }
      const next = JSON.parse(config) as unknown;
      if (JSON.stringify(row.config) === JSON.stringify(next)) {
        return { rows: [], rowCount: 0 };
      }
      if (row.config_revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `config_revision overflow: project=${projectId} current=${row.config_revision} cannot increment past ${Number.MAX_SAFE_INTEGER}`,
        );
      }
      row.config = next;
      row.config_revision += 1;
      return {
        rows: [{ config: row.config, revision: String(row.config_revision) }],
        rowCount: 1,
      };
    }
    if (/UPDATE projects SET config/u.test(sql)) {
      throw new Error("LWW UPDATE projects SET config is deleted — use revision CAS");
    }
    if (/UPDATE projects SET repo_url/u.test(sql)) {
      const [repoUrl, projectId] = params as [string, string];
      const row = projects().find((p) => p.project_id === projectId);
      if (row !== undefined) row.repo_url = repoUrl;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT org_id, default_branch FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = projects().find((p) => p.project_id === projectId);
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: row.org_id, default_branch: row.default_branch }], rowCount: 1 };
    }
    if (/SELECT org_id FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = projects().find((p) => p.project_id === projectId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: row.org_id }], rowCount: 1 };
    }
    if (
      /SELECT config, config_revision::text AS revision,/u.test(sql) &&
      /config IS NOT DISTINCT FROM/u.test(sql) &&
      /FROM projects WHERE project_id/u.test(sql)
    ) {
      const [projectId, nextJson] = params as [string, string];
      const row = projects().find((p) => p.project_id === projectId);
      if (row === undefined) return { rows: [], rowCount: 0 };
      const next = JSON.parse(nextJson) as unknown;
      return {
        rows: [
          {
            config: row.config,
            revision: String(row.config_revision),
            config_equal: JSON.stringify(row.config) === JSON.stringify(next),
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT config, config_revision::text AS revision FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = projects().find((p) => p.project_id === projectId);
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ config: row.config, revision: String(row.config_revision) }], rowCount: 1 };
    }
    if (/SELECT config FROM projects/u.test(sql)) {
      const [projectId] = params as [string];
      const row = projects().find((p) => p.project_id === projectId);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config: row.config }], rowCount: 1 };
    }
    if (/FROM projects WHERE org_id = \$1/u.test(sql)) {
      const [orgId] = params as [string];
      const rows = projects().filter((p) => p.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (/FROM projects WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = projects().filter((p) => p.project_id === projectId);
      return { rows, rowCount: rows.length };
    }

    // --- project specs (routes/specs CRUD) ---
    if (/UPDATE specs SET .* WHERE spec_id = /u.test(sql)) {
      // The dynamic PATCH binds the spec id last; the test exercises `title = $1`.
      const specId = params.at(-1) as string;
      const title = params[0] as string;
      const row = specs().find((s) => s.spec_id === specId);
      if (row !== undefined) row.title = title;
      return { rows: row ? [{ spec_id: row.spec_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM specs WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = specs().filter((s) => s.project_id === projectId);
      return { rows, rowCount: rows.length };
    }
    if (/FROM specs WHERE spec_id = \$1/u.test(sql)) {
      const [specId] = params as [string];
      const rows = specs().filter((s) => s.spec_id === specId);
      return { rows, rowCount: rows.length };
    }

    // --- personas ---
    if (/FROM personas WHERE org_id = \$1/u.test(sql)) {
      const [orgId] = params as [string];
      const rows = personas().filter((p) => p.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (/FROM personas WHERE id = \$1/u.test(sql)) {
      const [id] = params as [string];
      const rows = personas().filter((p) => p.id === id);
      return { rows, rowCount: rows.length };
    }

    // --- behaviors ---
    if (/FROM behaviors WHERE persona_id = \$1/u.test(sql)) {
      const [personaId] = params as [string];
      const rows = behaviors().filter((b) => b.persona_id === personaId);
      return { rows, rowCount: rows.length };
    }

    // --- milestones ---
    if (/FROM milestones WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = milestones().filter((m) => m.project_id === projectId);
      return { rows, rowCount: rows.length };
    }
    if (/FROM milestones WHERE id = \$1/u.test(sql)) {
      const [id] = params as [string];
      const rows = milestones().filter((m) => m.id === id);
      return { rows, rowCount: rows.length };
    }

    // --- spec dependencies ---
    if (/FROM spec_dependencies WHERE from_spec_id = \$1/u.test(sql)) {
      const [fromSpecId] = params as [string];
      const rows = specDeps().filter((d) => d.from_spec_id === fromSpecId);
      return { rows, rowCount: rows.length };
    }

    return undefined;
  }
}

describeRepositoriesConformance("pgRepositories (in-memory pg)", () => {
  const db = new MemoryDb();
  return {
    repositories: pgRepositories,
    seed: (data: SeedData) => {
      data.projects.forEach((p) => db.seedProject(p));
      data.specs?.forEach((s) => db.seedSpec(s));
      data.personas?.forEach((p) => db.seedPersona(p));
      data.behaviors?.forEach((b) => db.seedBehavior(b));
      data.milestones?.forEach((m) => db.seedMilestone(m));
      data.specDependencies?.forEach((d) => db.seedSpecDependency(d));
      data.runs?.forEach((r) => db.seedRun(r));
      data.runTasks?.forEach((t) => db.seedRunTask(t));
      data.events?.forEach((e) => db.seedEvent(e));
      data.costRecords?.forEach((c) => db.seedCostRecord(c));
    },
    clientForOrg: (orgId): QueryClient => new ScopedClient(db, orgId) as unknown as QueryClient,
  };
});
