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

describe("project progress completion blockers", () => {
  it("keeps a conflict dequeue blocking when a later same-spec completion belongs to a different candidate", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_candidate", org_id: "org_acme", name: "Candidate", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_candidate", "user_alice");
    pool.seedSpec({ spec_id: "spec_apex", project_id: "proj_candidate", title: "Apex progress", status: "merged" });
    pool.seedRun({
      run_id: "run_current",
      spec_id: "spec_apex",
      project_id: "proj_candidate",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/15",
    });
    pool.seedRun({
      run_id: "run_unrelated",
      spec_id: "spec_apex",
      project_id: "proj_candidate",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/14",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "spec_apex",
      run_id: "run_current",
      project_id: "proj_candidate",
      payload: {
        integration: "native_queue",
        reason: "conflict",
        prNumber: 15,
        prUrl: "https://github.com/acme/apex/pull/15",
        message: "PR is dirty against main",
      },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_apex",
      run_id: "run_unrelated",
      project_id: "proj_candidate",
      payload: {
        integration: "native_queue",
        prNumber: 14,
        prUrl: "https://github.com/acme/apex/pull/14",
      },
    });

    const body = await progress(app, "proj_candidate");
    expect(body.specCounts.merged).toBe(1);
    expect(body.v1Reached).toBe(false);
    expect(body.percentComplete).toBe(0);
    expect(body.blocked).toEqual([{ specId: "spec_apex", title: "Apex progress", status: "completion_blocked" }]);
  });

  it("lets a later same-candidate merge.completed clear an older conflict dequeue", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_clear_conflict", org_id: "org_acme", name: "Clear", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_clear_conflict", "user_alice");
    pool.seedSpec({
      spec_id: "spec_clear",
      project_id: "proj_clear_conflict",
      title: "Clear conflict",
      status: "merged",
    });
    pool.seedRun({
      run_id: "run_clear_conflict",
      spec_id: "spec_clear",
      project_id: "proj_clear_conflict",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/15",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "spec_clear",
      run_id: "run_clear_conflict",
      project_id: "proj_clear_conflict",
      payload: { integration: "native_queue", reason: "conflict", prNumber: 15 },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_clear",
      run_id: "run_clear_conflict",
      project_id: "proj_clear_conflict",
      payload: { integration: "native_queue", prNumber: 15 },
    });

    const body = await progress(app, "proj_clear_conflict");
    expect(body.v1Reached).toBe(true);
    expect(body.percentComplete).toBe(100);
    expect(body.blocked).toEqual([]);
  });

  it("clears a number-only conflict blocker by a later same-number merge.completed with a PR URL", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({
      project_id: "proj_number_to_url",
      org_id: "org_acme",
      name: "Number to URL",
      repo_url: "https://github.com/acme/apex",
    });
    pool.seedProjectMember("proj_number_to_url", "user_alice");
    pool.seedSpec({
      spec_id: "spec_number_to_url",
      project_id: "proj_number_to_url",
      title: "Number to URL",
      status: "merged",
    });
    pool.seedRun({
      run_id: "run_number_to_url_block",
      spec_id: "spec_number_to_url",
      project_id: "proj_number_to_url",
      status: "completed",
      outcome: "ok",
    });
    pool.seedRun({
      run_id: "run_number_to_url_done",
      spec_id: "spec_number_to_url",
      project_id: "proj_number_to_url",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/15",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "spec_number_to_url",
      run_id: "run_number_to_url_block",
      project_id: "proj_number_to_url",
      payload: { integration: "native_queue", reason: "conflict", prNumber: 15 },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_number_to_url",
      run_id: "run_number_to_url_done",
      project_id: "proj_number_to_url",
      payload: { integration: "native_queue", prNumber: 15, prUrl: "https://github.com/acme/apex/pull/15" },
    });

    const body = await progress(app, "proj_number_to_url");
    expect(body.v1Reached).toBe(true);
    expect(body.percentComplete).toBe(100);
    expect(body.blocked).toEqual([]);
  });

  it("does not clear by prNumber alone when both candidates have different PR URLs", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({
      project_id: "proj_repo_local",
      org_id: "org_acme",
      name: "Repo local",
      repo_url: "https://x/r",
    });
    pool.seedProjectMember("proj_repo_local", "user_alice");
    pool.seedSpec({ spec_id: "spec_repo_local", project_id: "proj_repo_local", title: "Repo local", status: "merged" });
    pool.seedRun({
      run_id: "run_repo_a",
      spec_id: "spec_repo_local",
      project_id: "proj_repo_local",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/15",
    });
    pool.seedRun({
      run_id: "run_repo_b",
      spec_id: "spec_repo_local",
      project_id: "proj_repo_local",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/other/pull/15",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "spec_repo_local",
      run_id: "run_repo_a",
      project_id: "proj_repo_local",
      payload: {
        integration: "native_queue",
        reason: "conflict",
        prNumber: 15,
        prUrl: "https://github.com/acme/apex/pull/15",
      },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_repo_local",
      run_id: "run_repo_b",
      project_id: "proj_repo_local",
      payload: {
        integration: "native_queue",
        prNumber: 15,
        prUrl: "https://github.com/acme/other/pull/15",
      },
    });

    const body = await progress(app, "proj_repo_local");
    expect(body.v1Reached).toBe(false);
    expect(body.percentComplete).toBe(0);
    expect(body.blocked).toEqual([{ specId: "spec_repo_local", title: "Repo local", status: "completion_blocked" }]);
  });

  it("clears by prNumber when neither side has a PR URL", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({
      project_id: "proj_number_only",
      org_id: "org_acme",
      name: "Number only",
      repo_url: "https://x/r",
    });
    pool.seedProjectMember("proj_number_only", "user_alice");
    pool.seedSpec({
      spec_id: "spec_number_only",
      project_id: "proj_number_only",
      title: "Number only",
      status: "merged",
    });
    pool.seedRun({
      run_id: "run_number_block",
      spec_id: "spec_number_only",
      project_id: "proj_number_only",
      status: "completed",
      outcome: "ok",
    });
    pool.seedRun({
      run_id: "run_number_done",
      spec_id: "spec_number_only",
      project_id: "proj_number_only",
      status: "completed",
      outcome: "ok",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "spec_number_only",
      run_id: "run_number_block",
      project_id: "proj_number_only",
      payload: { integration: "native_queue", reason: "conflict", prNumber: 15 },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_number_only",
      run_id: "run_number_done",
      project_id: "proj_number_only",
      payload: { integration: "native_queue", prNumber: 15 },
    });

    const body = await progress(app, "proj_number_only");
    expect(body.v1Reached).toBe(true);
    expect(body.percentComplete).toBe(100);
    expect(body.blocked).toEqual([]);
  });

  it("clears a number-only batch member blocker even when the batch head run has a different PR URL", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_batch_member", org_id: "org_acme", name: "Batch", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_batch_member", "user_alice");
    pool.seedSpec({ spec_id: "spec_head", project_id: "proj_batch_member", title: "Batch head", status: "merged" });
    pool.seedSpec({ spec_id: "spec_member", project_id: "proj_batch_member", title: "Batch member", status: "merged" });
    pool.seedRun({
      run_id: "run_batch_head",
      spec_id: "spec_head",
      project_id: "proj_batch_member",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/99",
    });
    pool.seedRun({
      run_id: "run_member_done",
      spec_id: "spec_member",
      project_id: "proj_batch_member",
      status: "completed",
      outcome: "ok",
      pr_url: "https://github.com/acme/apex/pull/15",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.batch.infra_blocked",
      spec_id: "spec_head",
      run_id: "run_batch_head",
      project_id: "proj_batch_member",
      payload: {
        integration: "native_queue",
        terminal: true,
        members: [{ specId: "spec_member", prNumber: 15 }],
        message: "batch member blocked",
      },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "spec_member",
      run_id: "run_member_done",
      project_id: "proj_batch_member",
      payload: { integration: "native_queue", prNumber: 15, prUrl: "https://github.com/acme/apex/pull/15" },
    });

    const body = await progress(app, "proj_batch_member");
    expect(body.v1Reached).toBe(true);
    expect(body.percentComplete).toBe(100);
    expect(body.blocked).toEqual([]);
  });
});
