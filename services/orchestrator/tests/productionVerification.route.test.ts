import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { SymptomContractRow } from "../src/engine/repositories/symptomContracts.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createProductionVerificationRoutes } from "../src/routes/issueLoops/productionVerification.js";

const ACTOR: ActorContext = {
  userId: "user_admin",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

const contract = {
  id: "contract_1",
  projectId: "project_1",
  issueLoopId: "loop_1",
} as SymptomContractRow;

function appFor(enqueued: unknown[] = []) {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route(
    "/v1/orgs",
    createProductionVerificationRoutes({
      pool: {} as never,
      contracts: {
        async get() {
          return contract;
        },
      },
      releaseById: async () => ({ projectId: "project_1", environment: "production", state: "live" }),
      enqueue: {
        async enqueue(input) {
          enqueued.push(input);
          return { id: "rjob_manual_1", created: true };
        },
      },
      jobId: () => "rjob_manual_1",
    }),
  );
  return app;
}

describe("production verification retry route", () => {
  it("queues a locked production replay at the public v1 callable surface", async () => {
    const enqueued: unknown[] = [];
    const response = await appFor(enqueued).request(
      "/v1/orgs/org_acme/projects/project_1/issue-loops/loop_1/retry-verification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractId: "contract_1",
          releaseInstanceId: "release_1",
          idempotencyKey: "operator-retry-1",
        }),
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      version: "v1",
      orgId: "org_acme",
      projectId: "project_1",
      issueLoopId: "loop_1",
      resolutionJobId: "rjob_manual_1",
      queued: true,
    });
    expect(enqueued).toEqual([
      expect.objectContaining({
        id: "rjob_manual_1",
        contractId: "contract_1",
        releaseInstanceId: "release_1",
        stage: "production",
        idempotencyKey: "operator-retry-1",
      }),
    ]);
  });
});
