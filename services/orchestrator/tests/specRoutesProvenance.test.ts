// Codex H3 #8 — the dashboard-facing spec routes (`GET .../specs`,
// `GET .../specs/:specId`) now surface the four triage-routing PROVENANCE
// columns (Claude RA2, migration 0025) as a `triageProvenance` block. Before
// this fix, the routes' `toSpecContract` mapper omitted the block entirely
// even though the columns had persisted since PR #755 — the dashboard could
// not render the routing chain for a routed spec, only the ephemeral discovery
// jsonb blob. This test drives the routes with a stubbed pool that returns
// row shapes matching what `ProjectSpecStore.{list,get}` return, and asserts
// the JSON responses expose the trail (routed) or omit it (non-routed).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createSpecRoutes } from "../src/routes/specs/index.js";

const ORG = "org_alpha";
const PROJECT = "project_alpha";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface FakeSpec {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
  priority: string;
  parent_spec_id: string | null;
  source_finding_ids: unknown;
  origin_triage_task_id: string | null;
  origin_run_id: string | null;
}

class SpecReadPool {
  readonly specs: FakeSpec[] = [];
  readonly projectOrg = new Map<string, string | null>();

  seedProject(projectId: string, orgId: string): void {
    this.projectOrg.set(projectId, orgId);
  }
  seedSpec(spec: FakeSpec): void {
    this.specs.push(spec);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(sql) || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT org_id FROM projects")) {
      const orgId = this.projectOrg.get(String(params[0])) ?? null;
      return { rows: [{ org_id: orgId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT role FROM project_members")) {
      return { rows: [], rowCount: 0 };
    }
    // spec list
    if (/FROM specs\s+WHERE project_id = \$1\s+ORDER BY title/u.test(sql)) {
      const rows = this.specs.filter((s) => s.project_id === String(params[0]));
      return { rows, rowCount: rows.length };
    }
    // spec detail
    if (/FROM specs WHERE spec_id = \$1/u.test(sql)) {
      const row = this.specs.find((s) => s.spec_id === String(params[0]));
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return { query: (s: string, p?: unknown[]) => this.query(s, p ?? []), release: () => {} } as never;
  }
  release(): void {}
  asPgPool() {
    return this as never;
  }
}

function buildApp(pool: SpecReadPool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return alice;
        },
      } as never,
      localDevActor: alice,
    }),
  );
  app.route("/orgs", createSpecRoutes({ pool: pool.asPgPool() }));
  return app;
}

function routedRow(): FakeSpec {
  return {
    spec_id: "spec_routed",
    project_id: PROJECT,
    title: "Routed spec",
    description: "auto-routed",
    acceptance_criteria: ["ac"],
    depends_on: [],
    status: "open",
    priority: "tbd",
    parent_spec_id: "spec_parent",
    source_finding_ids: ["finding_a", "finding_b"],
    origin_triage_task_id: "task_triage_x",
    origin_run_id: "run_source_x",
  };
}

function seededRow(): FakeSpec {
  return {
    spec_id: "spec_seed",
    project_id: PROJECT,
    title: "Seed spec",
    description: "operator-authored",
    acceptance_criteria: ["ac"],
    depends_on: [],
    status: "open",
    priority: "P0",
    parent_spec_id: null,
    source_finding_ids: null,
    origin_triage_task_id: null,
    origin_run_id: null,
  };
}

describe("routes/specs — triage PROVENANCE on responses (Codex H3 #8)", () => {
  // A routed spec's detail response carries the triageProvenance block so the
  // dashboard can render the routing chain (parent + finding ids + origin
  // task/run) without a second fetch of the discovery jsonb metadata.
  it("GET spec-detail returns triageProvenance for a routed spec", async () => {
    const pool = new SpecReadPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedSpec(routedRow());
    const app = buildApp(pool);
    const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs/spec_routed`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { triageProvenance?: unknown };
    expect(body.triageProvenance).toEqual({
      parentSpecId: "spec_parent",
      sourceFindingIds: ["finding_a", "finding_b"],
      originTriageTaskId: "task_triage_x",
      originRunId: "run_source_x",
    });
  });

  // A non-routed spec's detail response omits the block — matching the shape
  // an operator-authored / discovery / seed spec had before the migration.
  it("GET spec-detail omits triageProvenance for a non-routed spec", async () => {
    const pool = new SpecReadPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedSpec(seededRow());
    const app = buildApp(pool);
    const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs/spec_seed`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("triageProvenance");
  });

  // The spec-list response likewise threads the trail per row — the dashboard
  // spec list can badge a routed spec with its origin without an N+1 fetch
  // across the list.
  it("GET spec-list threads triageProvenance per row", async () => {
    const pool = new SpecReadPool();
    pool.seedProject(PROJECT, ORG);
    pool.seedSpec(seededRow());
    pool.seedSpec(routedRow());
    const app = buildApp(pool);
    const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { specs: Array<Record<string, unknown>> };
    const bySpecId = new Map(body.specs.map((s) => [s.specId as string, s]));
    expect(bySpecId.get("spec_seed")).not.toHaveProperty("triageProvenance");
    expect(bySpecId.get("spec_routed")).toHaveProperty("triageProvenance");
  });
});
