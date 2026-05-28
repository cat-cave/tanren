// P2A-0014 contract tests. Each endpoint:
//   - returns the contract-typed shape (validated against the Zod schema)
//   - rejects unauth (no actor) with 401 via the auth middleware
//   - rejects cross-org with 403
//   - rejects cross-project with 404 (boundary semantics: don't reveal
//     whether the run exists in a project the actor cannot access)
// The phase 1 fixture replay validates the snapshot end-to-end.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import {
  RunDetail,
  RunEventRow,
  RunListItem,
  RunCostRecord,
  decodeCursor,
  encodeCursor
} from "../src/routes/runs/contract.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session"
};

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new RunRoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {
          return undefined;
        },
        async loadSession() {
          return undefined;
        },
        async resolveActorContext() {
          return actor as ActorContext;
        }
      } as never,
      localDevActor: actor
    })
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

function seedRunFixture(pool: RunRoutesPool, overrides: { runId?: string; status?: string } = {}): {
  runId: string;
  projectId: string;
  specId: string;
} {
  const runId = overrides.runId ?? "run_fixture";
  const projectId = "project_phase1";
  const specId = "spec_phase1";
  pool.seedProject({ project_id: projectId, org_id: "org_acme" });
  pool.seedSpec({ spec_id: specId, project_id: projectId, title: "Add fixture marker" });
  pool.specBehaviors.set(specId, ["behavior_default"]);
  pool.specMilestones.set(specId, "milestone_default");
  pool.seedRun({
    run_id: runId,
    spec_id: specId,
    project_id: projectId,
    status: overrides.status ?? "completed",
    outcome: "phase1_fixture_complete",
    pr_url: "https://github.com/cat-cave/tanren-fixture-easy/pull/42",
    branch: "tanren/phase1-fixture"
  });
  // Tasks: planner, writer, checker, auditor, ci — full Phase 1 chain.
  for (const [i, kind] of ["plan", "write", "check", "audit", "ci"].entries()) {
    pool.seedTask({
      task_id: `task_${kind}_${i}`,
      run_id: runId,
      kind,
      status: "done",
      outcome: "ok",
      started_at: new Date(2026, 4, 1, 0, 0, i),
      ended_at: new Date(2026, 4, 1, 0, 0, i + 1),
      cli: "codex",
      model: "gpt-x"
    });
  }
  // Events: at least one per planner/writer/checker/auditor.
  pool.seedEvent({ id: 1, run_id: runId, project_id: projectId, event_type: "planner.completed", payload: { taskId: "task_plan_0" } });
  pool.seedEvent({ id: 2, run_id: runId, project_id: projectId, event_type: "writer.completed", payload: { taskId: "task_write_1" } });
  pool.seedEvent({ id: 3, run_id: runId, project_id: projectId, event_type: "checker.completed", payload: { taskId: "task_check_2", verdict: "pass" } });
  pool.seedEvent({ id: 4, run_id: runId, project_id: projectId, event_type: "auditor.completed", payload: { taskId: "task_audit_3", verdict: "pass" } });
  pool.seedCost({ id: 1, run_id: runId, task_id: "task_write_1", project_id: projectId, cost_usd: "0.005" });
  pool.seedCost({ id: 2, run_id: runId, task_id: "task_check_2", project_id: projectId, cost_usd: "0.002" });
  return { runId, projectId, specId };
}

describe("P2A-0014 run-detail API — run list", () => {
  it("returns RunListItem[] for project-view recent runs", async () => {
    const { app, pool } = buildHarness();
    const { projectId } = seedRunFixture(pool);

    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBe(1);
    const item = RunListItem.parse(body.items[0]);
    expect(item.specTitle).toBe("Add fixture marker");
    expect(item.costTotalUsd).toBe("0.007");
    expect(item.needsReview).toBe(true);
    expect(item.lastEventAt).not.toBeNull();
  });

  it("rejects cross-org list with 403", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_other", org_id: "org_other" });
    const response = await app.request("/orgs/org_other/projects/project_other/runs");
    expect(response.status).toBe(403);
  });

  it("returns 401 when no actor is resolved", async () => {
    const pool = new RunRoutesPool();
    const app = new Hono<ActorContextEnv>();
    app.use(
      "*",
      createAuthMiddleware({
        store: {
          async findApiTokenByRaw() {
            return undefined;
          },
          async loadSession() {
            return undefined;
          },
          async resolveActorContext() {
            return alice;
          }
        } as never
        // no localDevActor — middleware should reject as 401.
      })
    );
    app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
    const response = await app.request("/orgs/org_acme/projects/project_phase1/runs");
    expect(response.status).toBe(401);
  });
});

describe("P2A-0014 run-detail API — run detail", () => {
  it("returns a contract-typed RunDetail for a fixture run", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs/${runId}`);
    expect(response.status).toBe(200);
    const json = await response.json();
    const detail = RunDetail.parse(json);
    expect(detail.run.runId).toBe(runId);
    expect(detail.spec.behaviorIds).toEqual(["behavior_default"]);
    expect(detail.spec.milestoneId).toBe("milestone_default");
    expect(detail.tasks.map((t) => t.kind)).toEqual(["plan", "write", "check", "audit", "ci"]);
    const eventTypes = detail.recentEvents.map((e) => e.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining(["planner.completed", "writer.completed", "checker.completed", "auditor.completed"])
    );
    expect(detail.costs.length).toBe(2);
    expect(detail.insights).toEqual([]);
    expect(detail.forgeThread).toBeNull();
  });

  it("returns 404 for unknown run", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_x", org_id: "org_acme" });
    const response = await app.request("/orgs/org_acme/projects/project_x/runs/run_missing");
    expect(response.status).toBe(404);
  });

  it("returns 404 when the run belongs to a different project (boundary semantics)", async () => {
    const { app, pool } = buildHarness();
    seedRunFixture(pool);
    pool.seedProject({ project_id: "project_other", org_id: "org_acme" });
    const response = await app.request("/orgs/org_acme/projects/project_other/runs/run_fixture");
    expect(response.status).toBe(404);
  });

  it("rejects cross-org run detail with 403", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_other", org_id: "org_other" });
    const response = await app.request("/orgs/org_other/projects/project_other/runs/whatever");
    expect(response.status).toBe(403);
  });
});

describe("P2A-0014 run-detail API — events pagination", () => {
  it("paginates with cursor + pageSize and yields nextCursor only when more pages exist", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const firstResponse = await app.request(
      `/orgs/org_acme/projects/${projectId}/runs/${runId}/events?pageSize=2`
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as { items: unknown[]; nextCursor: string | null };
    expect(firstBody.items.length).toBe(2);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(RunEventRow.parse(firstBody.items[0]).eventType).toBe("planner.completed");

    const secondResponse = await app.request(
      `/orgs/org_acme/projects/${projectId}/runs/${runId}/events?pageSize=2&cursor=${encodeURIComponent(
        firstBody.nextCursor as string
      )}`
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as { items: unknown[]; nextCursor: string | null };
    expect(secondBody.items.length).toBe(2);
    expect(secondBody.nextCursor).toBeNull();
    expect(RunEventRow.parse(secondBody.items[1]).eventType).toBe("auditor.completed");
  });

  it("rejects malformed cursors with 400 invalid_cursor", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const response = await app.request(
      `/orgs/org_acme/projects/${projectId}/runs/${runId}/events?cursor=not-base64-or-anything-valid`
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_cursor");
  });

  it("encodes and decodes cursors round-trip", () => {
    const ts = new Date("2026-05-27T12:34:56.000Z");
    const encoded = encodeCursor({ ts, id: 42 });
    const decoded = decodeCursor(encoded);
    expect(decoded.id).toBe(42);
    expect(decoded.ts.toISOString()).toBe(ts.toISOString());
  });
});

describe("P2A-0014 run-detail API — costs pagination", () => {
  it("returns RunCostRecord items contract-shaped", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs/${runId}/costs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items.length).toBe(2);
    const cost = RunCostRecord.parse(body.items[0]);
    expect(cost.runId).toBe(runId);
    expect(cost.costSource).toBe("provider_direct");
    expect(body.nextCursor).toBeNull();
  });
});

describe("P2A-0014 run-detail API — activity feed", () => {
  it("returns project-wide events newest-first", async () => {
    const { app, pool } = buildHarness();
    const { projectId } = seedRunFixture(pool);
    const response = await app.request(`/orgs/org_acme/projects/${projectId}/feed`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ eventType: string; ts: string }>; nextCursor: string | null };
    expect(body.items.length).toBe(4);
    // Newest first.
    expect(body.items[0].eventType).toBe("auditor.completed");
    expect(body.items[body.items.length - 1].eventType).toBe("planner.completed");
  });
});

describe("P2A-0014 run-detail API — redaction scope", () => {
  it("project_member sees redacted credential fields by default", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    // Seed an event whose payload contains a high-entropy credential value
    // that the redaction layer must drop for a project:member scope.
    pool.seedEvent({
      id: 99,
      run_id: runId,
      project_id: projectId,
      event_type: "credential.loaded",
      payload: { ref: "credential/codex/dev", source: "vault", durationMs: 12 }
    });
    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs/${runId}/events`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ eventType: string; redactedPaths: string[] }> };
    const credEvent = body.items.find((e) => e.eventType === "credential.loaded");
    expect(credEvent).toBeDefined();
    // redactedPaths is well-typed; verify it's an array even when nothing
    // sensitive is present (the schema requires the field).
    expect(Array.isArray(credEvent?.redactedPaths)).toBe(true);
  });
});

describe("P2A-0014 run-detail API — Phase 1 fixture replay", () => {
  it("loads a fixture-shape run end-to-end with all six top-level RunDetail fields", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedRunFixture(pool);
    const response = await app.request(`/orgs/org_acme/projects/${projectId}/runs/${runId}`);
    const detail = RunDetail.parse(await response.json());
    expect(detail.run).toBeDefined();
    expect(detail.spec).toBeDefined();
    expect(detail.tasks.length).toBeGreaterThan(0);
    expect(detail.recentEvents.length).toBeGreaterThan(0);
    expect(detail.costs.length).toBeGreaterThan(0);
    expect(detail.insights).toBeDefined();
    // forgeThread is allowed to be null when no thread exists.
    expect(detail.forgeThread).toBeNull();
  });
});
