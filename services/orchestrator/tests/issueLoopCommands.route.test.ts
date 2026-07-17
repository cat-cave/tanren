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
});
