// Drives the pg-backed `Repositories` seam (pgRepositories) through the shared
// conformance suite. The backing store is an in-memory `pg` query target that
// understands the small set of statements the repositories emit and — crucially
// — models RLS row visibility: a client scoped to org X (one that carried `SET
// LOCAL app.current_org_id = 'X'`) sees only org X's rows, so the suite's
// off-scope assertions (org B sees ZERO of org A's rows) exercise the same
// row-filter contract the real org-scoped transaction provides. Tables without a
// literal org_id column (behaviors, milestones, spec_dependencies) carry an
// org tag in the harness purely to model that visibility gate; the SQL the
// stores emit selects only the real columns.
import { pgRepositories, type QueryClient } from "../../src/engine/contracts/repositories.js";
import {
  describeRepositoriesConformance,
  type SeedBehavior,
  type SeedData,
  type SeedMilestone,
  type SeedPersona,
  type SeedProject,
  type SeedSpec,
  type SeedSpecDependency,
} from "./repositoriesConformance.js";

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

interface SpecRecord {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
  org_id: string | null;
}

interface PersonaRecord {
  id: string;
  scope: string;
  org_id: string;
  project_id: string | null;
  name: string;
  description: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

interface BehaviorRecord {
  id: string;
  persona_id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  description: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  org_id: string | null;
}

interface MilestoneRecord {
  id: string;
  project_id: string;
  label: string;
  name: string;
  description: string | null;
  order_index: number;
  eta: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  org_id: string | null;
}

interface SpecDependencyRecord {
  from_spec_id: string;
  to_spec_id: string;
  created_at: Date;
  org_id: string | null;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

// In-memory store shared by every scoped client the harness hands out.
class MemoryDb {
  projects: ProjectRecord[] = [];
  specs: SpecRecord[] = [];
  personas: PersonaRecord[] = [];
  behaviors: BehaviorRecord[] = [];
  milestones: MilestoneRecord[] = [];
  specDependencies: SpecDependencyRecord[] = [];

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

  seedSpec(s: SeedSpec): void {
    this.specs.push({
      spec_id: s.specId,
      project_id: s.projectId,
      title: s.title,
      description: s.description,
      acceptance_criteria: s.acceptanceCriteria,
      depends_on: s.dependsOn,
      status: s.status,
      org_id: s.orgId,
    });
  }

  seedPersona(p: SeedPersona): void {
    this.personas.push({
      id: p.id,
      scope: p.scope,
      org_id: p.orgId,
      project_id: p.projectId,
      name: p.name,
      description: p.description,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    });
  }

  seedBehavior(b: SeedBehavior): void {
    const persona = this.personas.find((p) => p.id === b.personaId);
    /* eslint-disable unicorn/no-thenable */
    // `then` is the persisted BDD Given/When/Then column name, not a Promise hook.
    this.behaviors.push({
      id: b.id,
      persona_id: b.personaId,
      title: b.title,
      given: b.given,
      when: b.when,
      then: b.then,
      description: b.description,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      org_id: persona?.org_id ?? null,
    });
    /* eslint-enable unicorn/no-thenable */
  }

  seedMilestone(m: SeedMilestone): void {
    this.milestones.push({
      id: m.id,
      project_id: m.projectId,
      label: m.label,
      name: m.name,
      description: null,
      order_index: m.orderIndex,
      eta: null,
      status: m.status,
      created_at: NOW,
      updated_at: NOW,
      org_id: m.orgId,
    });
  }

  seedSpecDependency(d: SeedSpecDependency): void {
    this.specDependencies.push({
      from_spec_id: d.fromSpecId,
      to_spec_id: d.toSpecId,
      created_at: NOW,
      // The DAG edge inherits the org of its source spec for visibility modeling.
      org_id: this.specs.find((s) => s.spec_id === d.fromSpecId)?.org_id ?? "org_a",
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
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const projects = (): ProjectRecord[] => this.db.projects.filter((p) => p.org_id === this.orgId);
    const specs = (): SpecRecord[] => this.db.specs.filter((s) => s.org_id === this.orgId);
    const personas = (): PersonaRecord[] => this.db.personas.filter((p) => p.org_id === this.orgId);
    const behaviors = (): BehaviorRecord[] => this.db.behaviors.filter((b) => b.org_id === this.orgId);
    const milestones = (): MilestoneRecord[] => this.db.milestones.filter((m) => m.org_id === this.orgId);
    const specDeps = (): SpecDependencyRecord[] => this.db.specDependencies.filter((d) => d.org_id === this.orgId);

    // --- projects ---
    if (/UPDATE projects SET config/u.test(sql)) {
      const [config, projectId] = params as [string, string];
      const row = projects().find((p) => p.project_id === projectId);
      if (row !== undefined) row.config = JSON.parse(config);
      return { rows: [], rowCount: row ? 1 : 0 };
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

    throw new Error(`MemoryDb: unrecognized SQL in conformance harness: ${sql}`);
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
    },
    clientForOrg: (orgId): QueryClient => new ScopedClient(db, orgId) as unknown as QueryClient,
  };
});
