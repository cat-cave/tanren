// operator-triggered live workflow — contract test.
//
// The dashboard's "▶ start a run" affordance POSTs to a dashboard route that
// calls the typed orchestrator client's `triggerRun`, which POSTs the
// org+project-scoped run-from-spec endpoint with `trigger: "dashboard"`. This
// test pins the orchestrator side of that contract (the live Codex run is the
// operator's manual QA — see docs/operator-guide/operator-driven-run.md):
//   - POST a spec, then POST a run from it with `trigger: "dashboard"`
//     returns 201 with a RunSummary recording the dashboard origin.
//   - cross-org access is rejected with 403 org_access_denied.
//   - a spec with an unmet (not-done) dependency returns 409
//     spec_dependencies_blocked — meaningful operator feedback, not swallowed.
//
// Mirrors the sibling contract-test harness (runRoutes.contract.test.ts): the
// org-scoped `createSpecRoutes` mounted behind the real auth middleware with a
// stubbed pg pool. The stub serves exactly the SQL the route + the
// `createQueuedRunFromSpec` engine fire.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createSpecRoutes } from "../src/routes/specs/index.js";

const ORG = "org_acme";
const PROJECT = "project_live";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new SpecRunPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor as ActorContext;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createSpecRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

async function createSpec(
  app: Hono<ActorContextEnv>,
  body: { title: string; description: string; acceptanceCriteria: string[]; dependsOn?: string[] },
): Promise<{ specId: string }> {
  const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { specId: string };
}

describe("P2B-0006 operator-triggered live run — contract", () => {
  it("triggers a run from a spec with trigger=dashboard and returns 201 RunSummary", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject(PROJECT, ORG);
    const spec = await createSpec(app, {
      title: "Supplier scorecard export",
      description: "Export the supplier scorecard",
      acceptanceCriteria: ["CSV export downloads"],
    });

    const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs/${spec.specId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "dashboard" }),
    });

    expect(response.status).toBe(201);
    const run = (await response.json()) as {
      runId: string;
      specId: string;
      projectId: string;
      trigger: string;
      status: string;
    };
    expect(run).toMatchObject({
      runId: expect.stringMatching(/^run_/u),
      specId: spec.specId,
      projectId: PROJECT,
      trigger: "dashboard",
      status: "queued",
    });
    // The dashboard origin is persisted on the run row.
    expect(pool.runs[0]).toMatchObject({ specId: spec.specId, trigger: "dashboard" });
    // A run.queued event records the dashboard trigger for the activity feed.
    expect(pool.events[0]).toMatchObject({ eventType: "run.queued" });
  });

  it("rejects a cross-org trigger with 403 org_access_denied", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject("project_other", "org_other");

    const response = await app.request(`/orgs/org_other/projects/project_other/specs/spec_whatever/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "dashboard" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "org_access_denied" });
  });

  it("returns 409 spec_dependencies_blocked when a dependency is not done", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject(PROJECT, ORG);
    const foundation = await createSpec(app, {
      title: "Foundation",
      description: "Prepare the repo",
      acceptanceCriteria: ["Foundation exists"],
    });
    const dependent = await createSpec(app, {
      title: "Dependent",
      description: "Needs foundation",
      acceptanceCriteria: ["Dependency is enforced"],
      dependsOn: [foundation.specId],
    });

    // foundation is still `pending` — the dependency is not done.
    const response = await app.request(`/orgs/${ORG}/projects/${PROJECT}/specs/${dependent.specId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "dashboard" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "spec_dependencies_blocked" });
  });
});

// ---------------------------------------------------------------------------
// Stub pg pool. Serves the SQL the spec route + createQueuedRunFromSpec engine
// fire: spec CRUD, project existence/org lookup, dependency checks, and the
// run/task/job/event inserts. Modeled on the ContractPool in
// projectSpecWorkflow.test.ts, scoped to the run-trigger path this spec owns.
// ---------------------------------------------------------------------------

interface SpecRow {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
  priority: string;
}

class SpecRunPool {
  readonly projects = new Map<string, { projectId: string; orgId: string }>();
  readonly specs = new Map<string, SpecRow>();
  readonly runs: Array<{
    runId: string;
    specId: string;
    projectId: string;
    trigger: string;
    branch: string;
  }> = [];
  readonly tasks: Array<{ taskId: string; runId: string }> = [];
  readonly jobs: Array<{ id: number; runId: string; taskId: string }> = [];
  readonly events: Array<{ runId: string; eventType: string; payload: unknown }> = [];

  seedProject(projectId: string, orgId: string): void {
    this.projects.set(projectId, { projectId, orgId });
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT project_id FROM projects WHERE project_id")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ project_id: project.projectId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT org_id FROM projects WHERE project_id")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: project.orgId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT role FROM project_members")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return this.selectSpecsForProject(String(params[0]), params[1] as string[]);
    }
    if (sql.includes("status = 'merged'") && sql.includes("spec_id = ANY")) {
      // Dependency-done check: only `merged` specs match. Unmerged deps yield [].
      return this.selectDoneSpecsForProject(String(params[0]), params[1] as string[]);
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const spec = specFromParams(params);
      this.specs.set(spec.specId, spec);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM specs s") && sql.includes("JOIN projects p")) {
      return this.selectSpecProject(String(params[0]));
    }
    if (sql.startsWith("UPDATE specs SET status = 'in_flight'")) {
      const spec = this.specs.get(String(params[0]));
      if (spec !== undefined && spec.status === "open") {
        spec.status = "in_flight";
        return { rows: [{ spec_id: spec.specId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO runs")) {
      // v68 fix: org_id at $4 shifts trigger→$5 (params[4]) and branch→$6 (params[5]).
      this.runs.push({
        runId: String(params[0]),
        specId: String(params[1]),
        projectId: String(params[2]),
        trigger: String(params[4]),
        branch: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      this.tasks.push({ taskId: String(params[0]), runId: String(params[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO job_queue")) {
      const id = this.jobs.length + 1;
      this.jobs.push({ id, runId: String(params[0]), taskId: String(params[1]) });
      return { rows: [{ id: String(id) }], rowCount: 1 };
    }
    if (sql.startsWith(`INSERT INTO ${"events"}`)) {
      // v68 fix: org_id at index 4; eventType + payload shift to 5/6.
      this.events.push({
        runId: String(params[0]),
        eventType: String(params[5]),
        payload: JSON.parse(String(params[6])) as unknown,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<SpecRunPool> {
    return this;
  }

  release(): void {}

  asPgPool() {
    return this as never;
  }

  private selectSpecsForProject(projectId: string, specIds: string[]): { rows: unknown[]; rowCount: number } {
    const rows = specIds
      .map((specId) => this.specs.get(specId))
      .filter((spec): spec is SpecRow => spec !== undefined && spec.projectId === projectId)
      .map((spec) => ({ spec_id: spec.specId }));
    return { rows, rowCount: rows.length };
  }

  private selectDoneSpecsForProject(projectId: string, specIds: string[]): { rows: unknown[]; rowCount: number } {
    const rows = specIds
      .map((specId) => this.specs.get(specId))
      .filter((spec): spec is SpecRow => spec !== undefined && spec.projectId === projectId && spec.status === "merged")
      .map((spec) => ({ spec_id: spec.specId }));
    return { rows, rowCount: rows.length };
  }

  private selectSpecProject(specId: string): { rows: unknown[]; rowCount: number } {
    const spec = this.specs.get(specId);
    const project = spec === undefined ? undefined : this.projects.get(spec.projectId);
    if (spec === undefined || project === undefined) {
      return { rows: [], rowCount: 0 };
    }
    // v68 fix: loader surfaces NOT NULL org_id on both project + spec rows.
    const row = {
      project_id: project.projectId,
      project_org_id: project.orgId,
      spec_org_id: project.orgId,
      name: "Live project",
      repo_url: "https://github.com/cat-cave/tanren-fixture-easy",
      default_branch: "main",
      runner_image: "ghcr.io/cat-cave/tanren-runner:v0",
      allocator: "local-docker",
      config: { version: 1 },
      lifecycle: "active",
      spec_id: spec.specId,
      title: spec.title,
      description: spec.description,
      acceptance_criteria: spec.acceptanceCriteria,
      depends_on: spec.dependsOn,
      status: spec.status,
      priority: spec.priority,
      // Task #86: `specs.mode` (NOT NULL, default `from_scratch`) is now non-optional in
      // the row schema. This fake doesn't track mode per spec, so echo the DB default.
      mode: "from_scratch",
    };
    return { rows: [row], rowCount: 1 };
  }
}

function specFromParams(params: unknown[]): SpecRow {
  // v68 fix: explicit org_id at $3 shifts every subsequent column by 1.
  return {
    specId: String(params[0]),
    projectId: String(params[1]),
    title: String(params[3]),
    description: String(params[4]),
    acceptanceCriteria: JSON.parse(String(params[5])) as string[],
    dependsOn: params[6] as string[],
    status: String(params[7]),
    priority: String(params[8]),
  };
}
