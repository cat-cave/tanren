// Former-bug proofs for run-detail (orgId, projectId, specId) binding and
// fail-loud behavior/milestone reads (PR #943 P1 redrive).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new RunRoutesPool();
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
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

describe("PR #943 run-detail spec binding", () => {
  it("same-org cross-project spec id fails non-200 without leaking foreign title/description/behaviors/milestone", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_a", org_id: "org_acme" });
    pool.seedProject({ project_id: "project_b", org_id: "org_acme" });
    // Spec lives only in project B — same org, different project.
    pool.seedSpec({
      spec_id: "spec_foreign",
      project_id: "project_b",
      title: "SECRET_FOREIGN_TITLE",
      description: "SECRET_FOREIGN_DESC",
    });
    pool.specBehaviors.set("spec_foreign", ["behavior_secret"]);
    pool.specMilestones.set("spec_foreign", "milestone_secret");
    // Run in project A incorrectly references the foreign-project spec id.
    pool.seedRun({
      run_id: "run_cross",
      spec_id: "spec_foreign",
      project_id: "project_a",
      status: "completed",
      outcome: "ok",
    });

    const response = await app.request("/orgs/org_acme/projects/project_a/runs/run_cross");
    expect(response.status).not.toBe(200);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("SECRET_FOREIGN_TITLE");
    expect(bodyText).not.toContain("SECRET_FOREIGN_DESC");
    expect(bodyText).not.toContain("behavior_secret");
    expect(bodyText).not.toContain("milestone_secret");
    const body = JSON.parse(bodyText) as { error?: string; spec?: unknown };
    expect(body.spec).toBeUndefined();
    expect(body.error).toBe("run_spec_not_found");
  });

  it("injected behavior-read failure surfaces non-200 without empty recovery context", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_a", org_id: "org_acme" });
    pool.seedSpec({
      spec_id: "spec_a",
      project_id: "project_a",
      title: "Visible",
      description: "ok",
    });
    pool.seedRun({
      run_id: "run_a",
      spec_id: "spec_a",
      project_id: "project_a",
      status: "running",
    });
    pool.behaviorReadError = new Error("spec_behaviors relation missing");

    const response = await app.request("/orgs/org_acme/projects/project_a/runs/run_a");
    expect(response.status).not.toBe(200);
    const text = await response.text();
    // Must not recover with a partial 200 + empty behaviorIds.
    expect(text).not.toContain('"behaviorIds":[]');
    expect(text).not.toContain('"title":"Visible"');
  });

  it("injected milestone-read failure surfaces non-200 without null milestone launder", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_a", org_id: "org_acme" });
    pool.seedSpec({
      spec_id: "spec_a",
      project_id: "project_a",
      title: "Visible",
      description: "ok",
    });
    pool.seedRun({
      run_id: "run_a",
      spec_id: "spec_a",
      project_id: "project_a",
      status: "running",
    });
    pool.milestoneReadError = new Error("spec_milestones relation missing");

    const response = await app.request("/orgs/org_acme/projects/project_a/runs/run_a");
    expect(response.status).not.toBe(200);
    const text = await response.text();
    expect(text).not.toContain('"milestoneId":null');
    expect(text).not.toContain('"title":"Visible"');
  });

  it("same-project constrained triple still returns full spec summary on 200", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_a", org_id: "org_acme" });
    pool.seedSpec({
      spec_id: "spec_a",
      project_id: "project_a",
      title: "Home title",
      description: "Home desc",
    });
    pool.specBehaviors.set("spec_a", ["behavior_home"]);
    pool.specMilestones.set("spec_a", "milestone_home");
    pool.seedRun({
      run_id: "run_a",
      spec_id: "spec_a",
      project_id: "project_a",
      status: "completed",
      outcome: "ok",
    });

    const response = await app.request("/orgs/org_acme/projects/project_a/runs/run_a");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      spec: { title: string; description: string; behaviorIds: string[]; milestoneId: string | null };
    };
    expect(body.spec.title).toBe("Home title");
    expect(body.spec.description).toBe("Home desc");
    expect(body.spec.behaviorIds).toEqual(["behavior_home"]);
    expect(body.spec.milestoneId).toBe("milestone_home");
  });
});
