// cspell:ignore rdec
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIssueLoopCommandRoutes } from "../src/routes/issueLoops/commands.js";

const ACTOR: ActorContext = {
  userId: "user_admin",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

function appFor(calls: string[]) {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route(
    "/v1/orgs",
    createIssueLoopCommandRoutes({
      pool: {} as never,
      contracts: {
        async get() {
          return { id: "contract_a", projectId: "project_a", issueLoopId: "loop_a" } as never;
        },
      },
      jobs: {
        async enqueue(input) {
          calls.push(`steer:${input.stage}`);
          return { id: "rjob_steered", created: true };
        },
        async belongsToIssueLoop(input) {
          return input.id !== "rjob_other_loop";
        },
        async pauseLoop() {
          calls.push("pause");
          return 2;
        },
        async resumeLoop() {
          calls.push("resume");
          return 2;
        },
      },
      jobId: () => "rjob_steered",
      authority: {
        async waive(input) {
          calls.push(`waive:${input.operatorId}`);
          return {
            id: "rdec_waived",
            decision: "waived",
            inputSnapshotHash: "sha256:" + "a".repeat(64),
            reasons: ["operator waiver recorded"],
            created: true,
          };
        },
      },
    }),
  );
  return app;
}

describe("issue-loop control commands", () => {
  it("offers callable steer, pause, and resume commands for durable loop work", async () => {
    const calls: string[] = [];
    const app = appFor(calls);
    const base = "/v1/orgs/org_a/projects/project_a/issue-loops/loop_a";

    const steer = await app.request(`${base}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractId: "contract_a", stage: "baseline", idempotencyKey: "operator-steer-1" }),
    });
    const pause = await app.request(`${base}/pause`, { method: "POST" });
    const resume = await app.request(`${base}/resume`, { method: "POST" });

    expect(steer.status).toBe(202);
    await expect(steer.json()).resolves.toMatchObject({ resolutionJobId: "rjob_steered", queued: true });
    await expect(pause.json()).resolves.toMatchObject({ paused: 2 });
    await expect(resume.json()).resolves.toMatchObject({ resumed: 2 });
    expect(calls).toEqual(["steer:baseline", "pause", "resume"]);
  });

  it("offers waiver to an authenticated org admin without exposing mark-authorized", async () => {
    const calls: string[] = [];
    const app = appFor(calls);
    const base = "/v1/orgs/org_a/projects/project_a/issue-loops/loop_a";
    const waived = await app.request(`${base}/waive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionJobId: "rjob_a", reason: "operator accepts attested external evidence" }),
    });
    const publicAuthorize = await app.request(`${base}/authorize`, { method: "POST" });

    expect(waived.status).toBe(200);
    await expect(waived.json()).resolves.toMatchObject({ resolutionDecision: { decision: "waived" } });
    expect(publicAuthorize.status).toBe(404);
    expect(calls).toEqual(["waive:user_admin"]);
  });

  it("rejects a waiver when its resolution job belongs to a different loop", async () => {
    const calls: string[] = [];
    const app = appFor(calls);
    const response = await app.request("/v1/orgs/org_a/projects/project_a/issue-loops/loop_a/waive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionJobId: "rjob_other_loop", reason: "wrong loop" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "resolution_job_not_found" });
    expect(calls).toEqual([]);
  });
});
