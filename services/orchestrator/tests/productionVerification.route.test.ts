import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ResolutionJob, ResolutionStage, ResolutionStageKind } from "../src/engine/contracts/resolutionStage.js";
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

const VERDICT = {
  outcome: "passed" as const,
  classification: "product_resolved" as const,
  proofGrade: "active_causal" as const,
  verificationRunId: "vrun_1",
  assertionIds: ["assertion_1"],
  evidenceRefs: ["evidence_1"],
};

function appFor(enqueued: unknown[] = [], executed: ResolutionJob[] = [], completed: string[] = []) {
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
      executionLeaseOwner: () => "route_lease_1",
      jobs: {
        async claimById(input) {
          return {
            id: input.id,
            orgId: input.orgId,
            projectId: "project_1",
            issueLoopId: "loop_1",
            contractId: "contract_1",
            releaseInstanceId: "release_1",
            stage: "production",
            state: "running",
            leaseOwner: input.leaseOwner,
            leaseExpiry: "2026-07-17T19:00:00.000Z",
            idempotencyKey: "operator-retry-1",
            attempt: 2,
          };
        },
        async complete(input) {
          completed.push(`${input.id}:${input.leaseOwner}`);
          return true;
        },
        async release() {
          return true;
        },
      },
      stages: new Map<ResolutionStageKind, ResolutionStage>([
        [
          "production",
          {
            kind: "production",
            async run(job) {
              executed.push(job);
              return VERDICT;
            },
          },
        ],
      ]),
    }),
  );
  return app;
}

describe("production verification retry route", () => {
  it("runs the registered production stage at the public v1 callable surface", async () => {
    const enqueued: unknown[] = [];
    const executed: ResolutionJob[] = [];
    const completed: string[] = [];
    const response = await appFor(enqueued, executed, completed).request(
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "v1",
      orgId: "org_acme",
      projectId: "project_1",
      issueLoopId: "loop_1",
      resolutionJobId: "rjob_manual_1",
      queued: true,
      verdict: VERDICT,
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
    expect(executed).toEqual([
      expect.objectContaining({
        id: "rjob_manual_1",
        releaseInstanceId: "release_1",
        stage: "production",
        attempt: 2,
      }),
    ]);
    expect(completed).toEqual(["rjob_manual_1:route_lease_1"]);
  });
});
