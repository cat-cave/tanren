// P2B-0008 contract + integration tests for the four halted-run recovery
// actions. Uses an in-memory pg substitute (RecoveryMemoryPool) so no live
// runner or DB is required. Validates: authz (cross-org 403, wrong-project
// 404), each action's lineage event, rollback confirmation + no-prior-commit
// guards, and the real-functionality bar — a halted fixture-medium run
// recovered via "revise + replan" persists the halt → revise → replan lineage
// and queues a fresh planner run.

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRecoveryRoutes } from "../src/routes/recovery/index.js";
import { RecoveryMemoryPool } from "./helpers/recoveryMemoryPool.js";

const ORG = "org_acme";
const PROJECT = "project_medium";
const SPEC = "spec_a4f";
const RUN = "run_a347d4";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function harness(who: ActorContext | undefined = actor, seedCommit = true) {
  const pool = new RecoveryMemoryPool();
  pool.seedProject({ project_id: PROJECT, org_id: ORG });
  pool.seedProjectMember(PROJECT, actor.userId);
  pool.seedSpec({ spec_id: SPEC, project_id: PROJECT, status: "active" });
  pool.seedRun({
    run_id: RUN,
    spec_id: SPEC,
    project_id: PROJECT,
    status: "halted",
    outcome: "retry_budget_exhausted",
  });
  if (seedCommit) pool.seedGitCaptured(RUN, ["9f3a2b4"]);
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {
          return;
        },
        async loadSession() {
          return;
        },
        async resolveActorContext() {
          return who as ActorContext;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route("/orgs", createRecoveryRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

const base = `/orgs/${ORG}/projects/${PROJECT}/runs/${RUN}/recovery`;

function post(app: Hono<ActorContextEnv>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("P2B-0008 recovery context", () => {
  it("returns the run's recovery context incl. last-good commit", async () => {
    const res = await h.app.request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      specId: string;
      outcome: string;
      lastGoodCommit: string | null;
    };
    expect(body.specId).toBe(SPEC);
    expect(body.outcome).toBe("retry_budget_exhausted");
    expect(body.lastGoodCommit).toBe("9f3a2b4");
  });

  it("reports no last-good commit when none was captured", async () => {
    const noCommit = harness(actor, false);
    const body = (await (await noCommit.app.request(base)).json()) as {
      lastGoodCommit: string | null;
    };
    expect(body.lastGoodCommit).toBeNull();
  });
});

describe("P2B-0008 revise_spec", () => {
  it("routes to the spec-edit form and records lineage", async () => {
    const res = await post(h.app, `${base}/revise`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: { editHref: string; action: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result.action).toBe("revise_spec");
    expect(body.result.editHref).toContain(`/specs/${SPEC}/edit`);
    const lineage = h.pool.lineageEvents();
    expect(lineage.map((e) => e.event_type)).toContain("recovery.revise_routed");
  });
});

describe("P2B-0008 replan_with_steering", () => {
  it("appends the steering note to the spec, re-queues the planner, and records lineage", async () => {
    const note = "use a server-side cookie for first paint instead of inline script";
    const res = await post(h.app, `${base}/replan`, { steeringNote: note });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: { replanRunId: string; plannerTaskId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result.replanRunId).toMatch(/^run_/);
    expect(body.result.plannerTaskId).toMatch(/^task_/);

    // steering carried into the next planner invocation via the spec text
    expect(h.pool.specs.get(SPEC)?.description).toContain(note);
    // a fresh planner run + plan job were queued (the P2A-0012 loop picks it up)
    expect(h.pool.runs.has(body.result.replanRunId)).toBe(true);
    expect(h.pool.jobs.some((j) => j.task_kind === "plan" && j.run_id === body.result.replanRunId)).toBe(true);
    // lineage record persisted on the ORIGINAL halted run
    const replanEvent = h.pool.lineageEvents().find((e) => e.event_type === "recovery.replan_queued");
    expect(replanEvent?.run_id).toBe(RUN);
    const replanPayload = (replanEvent?.payload ?? {}) as { steeringNote?: string };
    expect(replanPayload.steeringNote).toBe(note);
  });

  it("rejects an empty steering note", async () => {
    const res = await post(h.app, `${base}/replan`, { steeringNote: "" });
    expect(res.status).toBe(400);
  });
});

describe("P2B-0008 rollback_to_commit", () => {
  it("rolls back to a confirmed known-good commit and re-queues", async () => {
    const res = await post(h.app, `${base}/rollback`, { commitSha: "9f3a2b4", confirmed: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { commitSha: string; replanRunId: string } };
    expect(body.result.commitSha).toBe("9f3a2b4");
    expect(h.pool.runs.has(body.result.replanRunId)).toBe(true);
    expect(h.pool.lineageEvents().some((e) => e.event_type === "recovery.rollback_queued")).toBe(true);
  });

  it("never destroys state without confirmation (confirmed:false → 400)", async () => {
    const res = await post(h.app, `${base}/rollback`, { commitSha: "9f3a2b4", confirmed: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rollback_not_confirmed");
    expect(h.pool.lineageEvents()).toHaveLength(0);
  });

  it("refuses rollback when no prior commit exists (409)", async () => {
    const noCommit = harness(actor, false);
    const res = await post(noCommit.app, `${base}/rollback`, {
      commitSha: "9f3a2b4",
      confirmed: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_prior_commit");
  });

  it("rejects an uncaptured commit (400)", async () => {
    const res = await post(h.app, `${base}/rollback`, { commitSha: "deadbeef", confirmed: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_commit");
  });
});

describe("P2B-0008 open_inspection_thread", () => {
  it("creates a run-scoped Forge thread and records lineage (no state change)", async () => {
    const res = await post(h.app, `${base}/inspection-thread`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { threadId: string } };
    expect(body.result.threadId).toMatch(/^forge_thread_/);
    const thread = h.pool.threads.get(body.result.threadId);
    expect(thread?.scope).toBe("run");
    expect(thread?.run_id).toBe(RUN);
    expect(h.pool.lineageEvents().some((e) => e.event_type === "recovery.inspection_opened")).toBe(true);
    // run state untouched
    expect(h.pool.runs.get(RUN)?.status).toBe("halted");
  });
});

describe("P2B-0008 authz", () => {
  it("denies cross-org access with 403", async () => {
    const res = await post(h.app, `/orgs/org_intruder/projects/${PROJECT}/runs/${RUN}/recovery/revise`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the run does not belong to the addressed project", async () => {
    const res = await post(h.app, `/orgs/${ORG}/projects/project_other/runs/${RUN}/recovery/revise`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await post(h.app, `/orgs/${ORG}/projects/${PROJECT}/runs/run_missing/recovery/revise`);
    expect(res.status).toBe(404);
  });
});

describe("P2B-0008 real-functionality bar — revise + replan chain", () => {
  it("persists the halt → revise → replan lineage across recovery", async () => {
    // operator picks "revise the spec"
    await post(h.app, `${base}/revise`);
    // then replans with steering after editing
    await post(h.app, `${base}/replan`, { steeringNote: "split behavior 5 into 5a + 5b" });

    const chain = h.pool.lineageEvents().map((e) => e.event_type);
    expect(chain).toEqual(["recovery.revise_routed", "recovery.replan_queued"]);
    // every lineage record is bound to the original halted run for run-detail history
    expect(h.pool.lineageEvents().every((e) => e.run_id === RUN)).toBe(true);
    // a fresh planner run is queued — the P2A-0012 loop runs it to completion
    expect(h.pool.jobs.some((j) => j.task_kind === "plan")).toBe(true);
  });
});
