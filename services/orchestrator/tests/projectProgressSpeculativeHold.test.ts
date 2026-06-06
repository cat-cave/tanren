import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { ProjectProgress } from "../src/routes/runs/progress.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { ProgressRoutesPool } from "./helpers/progressRoutesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness() {
  const pool = new ProgressRoutesPool();
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
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

async function progress(app: Hono<ActorContextEnv>, projectId: string): Promise<ProjectProgress> {
  const res = await app.request(`/orgs/org_acme/projects/${projectId}/progress`);
  expect(res.status).toBe(200);
  return ProjectProgress.parse(await res.json());
}

function seedHeldRun(pool: ProgressRoutesPool, projectId: string): void {
  pool.seedProject({
    project_id: projectId,
    org_id: "org_acme",
    name: "Speculative hold",
    repo_url: "https://github.com/acme/apex",
  });
  pool.seedProjectMember(projectId, "user_alice");
  pool.seedSpec({ spec_id: "spec_child", project_id: projectId, title: "Held child", status: "merged" });
  pool.seedRun({
    run_id: "run_child",
    spec_id: "spec_child",
    project_id: projectId,
    status: "completed",
    outcome: "ok",
    pr_url: "https://github.com/acme/apex/pull/14",
  });
  pool.seedEvent({
    id: 1,
    event_type: "merge.speculative_held",
    spec_id: "spec_child",
    run_id: "run_child",
    project_id: projectId,
    payload: {
      integration: "native_queue",
      prNumber: 14,
      prUrl: "https://github.com/acme/apex/pull/14",
      speculativeBase: "tanren/integ/spec_child",
      unmergedAncestors: ["spec_root"],
    },
  });
}

describe("project progress speculative-hold completion blockers", () => {
  it("blocks v1 when a spec was falsely completed after an unresolved speculative hold", async () => {
    const { app, pool } = buildHarness();
    seedHeldRun(pool, "proj_speculative_hold");
    pool.seedSpec({ spec_id: "spec_root", project_id: "proj_speculative_hold", title: "Root", status: "merged" });

    const body = await progress(app, "proj_speculative_hold");

    expect(body.specCounts.merged).toBe(2);
    expect(body.v1Reached).toBe(false);
    expect(body.percentComplete).toBe(50);
    expect(body.blocked).toEqual([{ specId: "spec_child", title: "Held child", status: "completion_blocked" }]);
  });

  it("clears a speculative-hold blocker after the same PR really merges", async () => {
    const { app, pool } = buildHarness();
    seedHeldRun(pool, "proj_speculative_cleared");
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_child",
      run_id: "run_child",
      project_id: "proj_speculative_cleared",
      payload: { integration: "native_queue", prNumber: 14, prUrl: "https://github.com/acme/apex/pull/14" },
    });

    const body = await progress(app, "proj_speculative_cleared");

    expect(body.v1Reached).toBe(true);
    expect(body.percentComplete).toBe(100);
    expect(body.blocked).toEqual([]);
  });
});
