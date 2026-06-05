// Route tests for the project-progress aggregate
// (GET /orgs/:orgId/projects/:projectId/progress). Drives the REAL run-route
// handler against an in-memory pool that covers the three reads it folds:
//   - the spec list (projectSpecs.listForProject)        → specCounts / blocked
//   - the project run list (fetchRunListItems)           → inFlight
//   - the project activity feed (fetchFeedPage)          → recentMilestones
// Asserts: counts/percent, v1Reached only when all merged, inFlight reflects
// running/queued runs, the per-inFlight `stage` derived from each run's latest
// event (writing/auditing/merging + the running fallback), the top-level
// `lastActivityAt` (newest event ts, advancing, null when quiet), milestones
// filtered to the milestone event types, the org-access-denied path, and no
// secret leakage in a milestone detail or a derived stage.

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

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new ProgressRoutesPool();
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

async function getJson(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A project with a mix of statuses + runs + a milestone-rich feed.
function seedMixedProject(pool: ProgressRoutesPool): void {
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", name: "Widget", repo_url: "https://example.com/r" });
  pool.seedProjectMember("proj_1", "user_alice");
  // 5 specs: 2 merged, 1 in_flight (running run), 1 pending (queued run), 1 halted.
  pool.seedSpec({ spec_id: "s_merged_a", project_id: "proj_1", title: "Merged A", status: "merged" });
  pool.seedSpec({ spec_id: "s_merged_b", project_id: "proj_1", title: "Merged B", status: "merged" });
  pool.seedSpec({ spec_id: "s_active", project_id: "proj_1", title: "Active", status: "in_flight" });
  pool.seedSpec({ spec_id: "s_pending", project_id: "proj_1", title: "Pending", status: "open" });
  pool.seedSpec({ spec_id: "s_halted", project_id: "proj_1", title: "Halted", status: "halted" });

  // Runs: the active spec's latest run is running (with a PR); the pending
  // spec's latest run is queued; the merged spec has a completed run (NOT
  // in-flight). Newest-first ordering is what `fetchRunListItems` returns.
  pool.seedRun({
    run_id: "run_active",
    spec_id: "s_active",
    project_id: "proj_1",
    status: "running",
    pr_url: "https://example.com/pull/7",
    started_at: new Date("2026-05-03T00:00:00Z"),
  });
  pool.seedRun({
    run_id: "run_pending",
    spec_id: "s_pending",
    project_id: "proj_1",
    status: "queued",
    started_at: new Date("2026-05-02T00:00:00Z"),
  });
  pool.seedRun({
    run_id: "run_merged",
    spec_id: "s_merged_a",
    project_id: "proj_1",
    status: "completed",
    pr_url: "https://example.com/pull/1",
    started_at: new Date("2026-05-01T00:00:00Z"),
  });

  // Feed: milestone events interleaved with non-milestone noise. Newest-first id.
  pool.seedEvent({
    id: 10,
    event_type: "merge.completed",
    spec_id: "s_merged_a",
    run_id: "run_merged",
    project_id: "proj_1",
    payload: { integration: "native_queue" },
  });
  pool.seedEvent({
    id: 9,
    event_type: "writer.started",
    spec_id: "s_active",
    run_id: "run_active",
    project_id: "proj_1",
    payload: {},
  });
  pool.seedEvent({
    id: 8,
    event_type: "github.pr.created",
    spec_id: "s_active",
    run_id: "run_active",
    project_id: "proj_1",
    payload: { prUrl: "https://example.com/pull/7" },
  });
  pool.seedEvent({
    id: 7,
    event_type: "dag.spec.enqueued",
    spec_id: "s_pending",
    run_id: "run_pending",
    project_id: "proj_1",
    payload: {},
  });
  pool.seedEvent({
    id: 6,
    event_type: "heartbeat",
    spec_id: null,
    run_id: "run_active",
    project_id: "proj_1",
    payload: {},
  });
}

describe("project progress route", () => {
  it("returns the aggregate shape with correct counts, percent, and v1Reached=false", async () => {
    const { app, pool } = buildHarness();
    seedMixedProject(pool);

    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    expect(status).toBe(200);
    // Validates the full contract shape (strict).
    const progress = ProjectProgress.parse(body);

    expect(progress.project).toEqual({ id: "proj_1", name: "Widget", repoUrl: "https://example.com/r" });
    expect(progress.specCounts.total).toBe(5);
    expect(progress.specCounts.merged).toBe(2);
    expect(progress.specCounts.active).toBe(1);
    expect(progress.specCounts.pending).toBe(1);
    expect(progress.specCounts.needsAttention).toBe(1);
    expect(progress.specCounts.other).toBe(0);
    // 2 merged / 5 total = 40%.
    expect(progress.percentComplete).toBe(40);
    expect(progress.v1Reached).toBe(false);
  });

  it("inFlight reflects the running/queued latest runs (not completed ones)", async () => {
    const { app, pool } = buildHarness();
    seedMixedProject(pool);
    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    const progress = ProjectProgress.parse(body);

    const ids = progress.inFlight.map((s) => s.specId).sort();
    expect(ids).toEqual(["s_active", "s_pending"]);
    const active = progress.inFlight.find((s) => s.specId === "s_active");
    expect(active?.runStatus).toBe("running");
    expect(active?.prUrl).toBe("https://example.com/pull/7");
    expect(active?.title).toBe("Active");
    // The completed merged-spec run is NOT in-flight.
    expect(ids).not.toContain("s_merged_a");
  });

  it("derives a per-inFlight stage from each run's latest event (writing; unknown→running fallback)", async () => {
    const { app, pool } = buildHarness();
    seedMixedProject(pool);
    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    const progress = ProjectProgress.parse(body);

    // run_active's latest stage-bearing event is writer.started (id 9), even
    // though an older github.pr.created (id 8) also exists for the run — newest
    // wins → "writing".
    const active = progress.inFlight.find((s) => s.specId === "s_active");
    expect(active?.stage).toBe("writing");
    // run_pending's only event is dag.spec.enqueued — not a stage-bearing
    // pipeline event → the "running" fallback.
    const pending = progress.inFlight.find((s) => s.specId === "s_pending");
    expect(pending?.stage).toBe("running");
  });

  it("maps the latest event to its coarse stage (auditor.started → auditing) and surfaces lastActivityAt", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_aud", org_id: "org_acme", name: "Aud", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_aud", "user_alice");
    pool.seedSpec({ spec_id: "sa", project_id: "proj_aud", title: "Auditing one", status: "in_flight" });
    pool.seedRun({ run_id: "run_aud", spec_id: "sa", project_id: "proj_aud", status: "running" });
    // A run mid-audit: the newest event is auditor.started, preceded by the
    // earlier checker/writer events. Newest-first ids; explicit ts so we can
    // assert lastActivityAt is the head event's timestamp.
    pool.seedEvent({
      id: 2,
      event_type: "writer.completed",
      spec_id: "sa",
      run_id: "run_aud",
      project_id: "proj_aud",
      ts: new Date("2026-05-10T00:00:00.000Z"),
    });
    pool.seedEvent({
      id: 3,
      event_type: "checker.passed",
      spec_id: "sa",
      run_id: "run_aud",
      project_id: "proj_aud",
      ts: new Date("2026-05-10T00:05:00.000Z"),
    });
    pool.seedEvent({
      id: 4,
      event_type: "auditor.started",
      spec_id: "sa",
      run_id: "run_aud",
      project_id: "proj_aud",
      ts: new Date("2026-05-10T00:10:00.000Z"),
    });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_aud/progress");
    const progress = ProjectProgress.parse(body);

    const item = progress.inFlight.find((s) => s.specId === "sa");
    expect(item?.stage).toBe("auditing");
    // lastActivityAt reflects the newest event (auditor.started @ 00:10).
    expect(progress.lastActivityAt).toBe("2026-05-10T00:10:00.000Z");

    // It advances: a newer merge.queued event becomes both the stage and the
    // lastActivityAt head.
    pool.seedEvent({
      id: 5,
      event_type: "merge.queued",
      spec_id: "sa",
      run_id: "run_aud",
      project_id: "proj_aud",
      ts: new Date("2026-05-10T00:15:00.000Z"),
    });
    const after = ProjectProgress.parse((await getJson(app, "/orgs/org_acme/projects/proj_aud/progress")).body);
    expect(after.inFlight.find((s) => s.specId === "sa")?.stage).toBe("merging");
    expect(after.lastActivityAt).toBe("2026-05-10T00:15:00.000Z");
    expect(new Date(after.lastActivityAt!).getTime()).toBeGreaterThan(new Date(progress.lastActivityAt!).getTime());
  });

  it("lastActivityAt is null when the project has no events", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_quiet", org_id: "org_acme", name: "Quiet", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_quiet", "user_alice");
    pool.seedSpec({ spec_id: "q1", project_id: "proj_quiet", title: "Q", status: "open" });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_quiet/progress");
    const progress = ProjectProgress.parse(body);
    expect(progress.lastActivityAt).toBeNull();
    expect(progress.inFlight).toEqual([]);
  });

  it("the derived stage never leaks a secret from the run's events", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_sec", org_id: "org_acme", name: "Sec", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_sec", "user_alice");
    pool.seedSpec({ spec_id: "x1", project_id: "proj_sec", title: "Sensitive", status: "in_flight" });
    pool.seedRun({ run_id: "run_sec", spec_id: "x1", project_id: "proj_sec", status: "running" });
    // The latest event for the run carries a secret-looking payload field; the
    // stage is derived from the event TYPE only, so the response must read
    // "writing" and the secret must appear nowhere in the serialized body.
    pool.seedEvent({
      id: 1,
      event_type: "writer.started",
      spec_id: "x1",
      run_id: "run_sec",
      project_id: "proj_sec",
      payload: { apiToken: "ghp_LEAKED_TOKEN_VALUE", model: "claude" },
    });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_sec/progress");
    const progress = ProjectProgress.parse(body);
    expect(progress.inFlight.find((s) => s.specId === "x1")?.stage).toBe("writing");
    expect(JSON.stringify(progress)).not.toContain("ghp_LEAKED_TOKEN_VALUE");
  });

  it("blocked lists halted/terminal-not-merged specs", async () => {
    const { app, pool } = buildHarness();
    seedMixedProject(pool);
    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    const progress = ProjectProgress.parse(body);
    expect(progress.blocked).toEqual([{ specId: "s_halted", title: "Halted", status: "halted" }]);
  });

  it("recentMilestones is filtered to milestone event types, newest-first", async () => {
    const { app, pool } = buildHarness();
    seedMixedProject(pool);
    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    const progress = ProjectProgress.parse(body);

    const types = progress.recentMilestones.map((m) => m.type);
    // Newest-first by event id; the non-milestone writer.started/heartbeat dropped.
    expect(types).toEqual(["merge.completed", "github.pr.created", "dag.spec.enqueued"]);
    expect(types).not.toContain("writer.started");
    expect(types).not.toContain("heartbeat");
    // Title resolved from the spec when cheap.
    const merge = progress.recentMilestones.find((m) => m.type === "merge.completed");
    expect(merge?.specId).toBe("s_merged_a");
    expect(merge?.title).toBe("Merged A");
  });

  it("v1Reached is true only when every spec is merged", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_done", org_id: "org_acme", name: "Done", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_done", "user_alice");
    pool.seedSpec({ spec_id: "d1", project_id: "proj_done", title: "One", status: "merged" });
    pool.seedSpec({ spec_id: "d2", project_id: "proj_done", title: "Two", status: "merged" });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "d1",
      run_id: "run_external",
      project_id: "proj_done",
      payload: { integration: "external_reviewer", reason: "blocked", message: "external reviewer blocked" },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.dequeued",
      spec_id: "d2",
      run_id: "run_conflict",
      project_id: "proj_done",
      payload: { integration: "native_queue", reason: "conflict", message: "recoverable conflict" },
    });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_done/progress");
    const progress = ProjectProgress.parse(body);
    expect(progress.v1Reached).toBe(true);
    expect(progress.percentComplete).toBe(100);
    expect(progress.specCounts.merged).toBe(2);
    expect(progress.blocked).toEqual([]);
  });

  it("does not mark v1 reached when a completed ok run later has a failed legacy dequeue", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_stale", org_id: "org_acme", name: "Stale", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_stale", "user_alice");
    pool.seedSpec({ spec_id: "stale_a", project_id: "proj_stale", title: "Already merged", status: "merged" });
    pool.seedSpec({ spec_id: "stale_b", project_id: "proj_stale", title: "Open PR", status: "merged" });
    pool.seedRun({
      run_id: "run_open_pr",
      spec_id: "stale_b",
      project_id: "proj_stale",
      status: "completed",
      outcome: "ok",
      pr_url: "https://example.com/pull/42",
    });
    pool.seedEvent({
      id: 1,
      event_type: "merge.completed",
      spec_id: "stale_b",
      run_id: "run_open_pr",
      project_id: "proj_stale",
      payload: { prUrl: "https://example.com/pull/42" },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.dequeued",
      spec_id: null,
      run_id: "run_open_pr",
      project_id: "proj_stale",
      payload: {
        reason: "failed",
        message: 'duplicate key value violates unique constraint "runners_pkey"',
      },
    });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_stale/progress");
    const progress = ProjectProgress.parse(body);

    expect(progress.specCounts.merged).toBe(2);
    expect(progress.v1Reached).toBe(false);
    expect(progress.percentComplete).toBe(50);
    expect(progress.recentMilestones[0]).toMatchObject({
      type: "merge.dequeued",
      specId: "stale_b",
      title: "Open PR",
      detail: 'duplicate key value violates unique constraint "runners_pkey"',
    });
    expect(progress.blocked).toEqual([{ specId: "stale_b", title: "Open PR", status: "completion_blocked" }]);
  });

  it("blocks completion when terminal merge infra is outside the recent feed window", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_deep", org_id: "org_acme", name: "Deep", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_deep", "user_alice");
    pool.seedSpec({ spec_id: "deep_a", project_id: "proj_deep", title: "Done", status: "merged" });
    pool.seedSpec({ spec_id: "deep_b", project_id: "proj_deep", title: "Terminal hold", status: "merged" });
    pool.seedRun({ run_id: "run_deep", spec_id: "deep_b", project_id: "proj_deep", status: "failed" });
    pool.seedEvent({
      id: 1,
      event_type: "merge.batch.infra_blocked",
      spec_id: "wrong_batch_row",
      run_id: "run_deep",
      project_id: "proj_deep",
      payload: {
        integration: "native_queue",
        members: [{ specId: "deep_b", prNumber: 42 }],
        message: "batch check setup exhausted",
        attempts: 3,
        terminal: true,
        consecutiveHolds: 3,
      },
    });
    for (let id = 2; id <= 205; id += 1) {
      pool.seedEvent({
        id,
        event_type: "writer.started",
        spec_id: "deep_a",
        run_id: `run_noise_${id}`,
        project_id: "proj_deep",
      });
    }

    const progress = ProjectProgress.parse((await getJson(app, "/orgs/org_acme/projects/proj_deep/progress")).body);

    expect(progress.specCounts.merged).toBe(2);
    expect(progress.v1Reached).toBe(false);
    expect(progress.percentComplete).toBe(50);
    expect(progress.recentMilestones.some((m) => m.type === "merge.batch.infra_blocked")).toBe(false);
    expect(progress.blocked).toEqual([{ specId: "deep_b", title: "Terminal hold", status: "completion_blocked" }]);
  });

  it("lets a newer merge.completed clear an older terminal merge dequeue failure", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_cleared", org_id: "org_acme", name: "Cleared", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_cleared", "user_alice");
    pool.seedSpec({ spec_id: "clear_a", project_id: "proj_cleared", title: "Cleared", status: "merged" });
    pool.seedRun({ run_id: "run_clear", spec_id: "clear_a", project_id: "proj_cleared", status: "completed" });
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: null,
      run_id: "run_clear",
      project_id: "proj_cleared",
      payload: { integration: "native_queue", specId: "clear_a", reason: "failed", message: "check setup failed" },
    });
    pool.seedEvent({
      id: 2,
      event_type: "merge.completed",
      spec_id: "clear_a",
      run_id: "run_clear",
      project_id: "proj_cleared",
      payload: { integration: "native_queue", prNumber: 7, prUrl: "https://example.com/pull/7" },
    });

    const progress = ProjectProgress.parse((await getJson(app, "/orgs/org_acme/projects/proj_cleared/progress")).body);
    expect(progress.v1Reached).toBe(true);
    expect(progress.percentComplete).toBe(100);
    expect(progress.blocked).toEqual([]);
  });

  it("a milestone detail surfaces a non-secret reason/message but never a secret value", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "proj_blk", org_id: "org_acme", name: "Blk", repo_url: "https://x/r" });
    pool.seedProjectMember("proj_blk", "user_alice");
    pool.seedSpec({ spec_id: "b1", project_id: "proj_blk", title: "Blocked one", status: "halted" });
    // The dequeue payload carries a human-readable reason/message AND (as a
    // worst case) a secret-looking field; the response must surface only the
    // message, never the secret.
    pool.seedEvent({
      id: 1,
      event_type: "merge.dequeued",
      spec_id: "b1",
      run_id: "run_b",
      project_id: "proj_blk",
      payload: { reason: "blocked", message: "merge blocked: required check failing", apiToken: "ghp_supersecret" },
    });
    pool.seedRun({ run_id: "run_b", spec_id: "b1", project_id: "proj_blk", status: "failed" });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_blk/progress");
    const progress = ProjectProgress.parse(body);
    const milestone = progress.recentMilestones.find((m) => m.type === "merge.dequeued");
    expect(milestone?.detail).toBe("merge blocked: required check failing");
    // No secret anywhere in the serialized response.
    expect(JSON.stringify(progress)).not.toContain("ghp_supersecret");
  });

  it("denies a cross-org actor with 403", async () => {
    const outsider: ActorContext = { ...alice, orgId: "org_other" };
    const { app, pool } = buildHarness(outsider);
    pool.seedProject({ project_id: "proj_1", org_id: "org_acme", name: "Widget", repo_url: "https://x/r" });

    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/progress");
    expect(status).toBe(403);
    expect(body.error).toBe("org_access_denied");
  });
});
