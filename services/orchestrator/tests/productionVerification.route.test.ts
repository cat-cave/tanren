import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type {
  ResolutionJob,
  ResolutionStage,
  ResolutionStageKind,
  ResolutionStageResult,
} from "../src/engine/contracts/resolutionStage.js";
import type { SymptomContractRow } from "../src/engine/repositories/symptomContracts.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import type { SettleReproofInput } from "../src/engine/verification/postMergeReproof/coordinator.js";
import type { BisectionResult } from "../src/engine/verification/postMergeReproof/regressionBisection.js";
import { createProductionVerificationRoutes } from "../src/routes/issueLoops/productionVerification.js";

const FAILURE_VERDICT = {
  outcome: "failed" as const,
  classification: "product_failure" as const,
  proofGrade: "active_causal" as const,
  verificationRunId: "vrun_failure",
  assertionIds: ["assertion_1"],
  evidenceRefs: ["evidence_1"],
};

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

const INCONCLUSIVE_VERDICT = {
  outcome: "inconclusive" as const,
  classification: "infra_failure" as const,
  proofGrade: "active_causal" as const,
  verificationRunId: "vrun_inconclusive",
  assertionIds: [],
  evidenceRefs: [],
};

function appFor(
  enqueued: unknown[] = [],
  executed: ResolutionJob[] = [],
  completed: string[] = [],
  released: unknown[] = [],
  verdict: ResolutionStageResult = VERDICT,
  authorizations: string[] = [],
  reproofSettles: SettleReproofInput[] = [],
) {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  app.route(
    "/v1/orgs",
    createProductionVerificationRoutes({
      pool: {} as never,
      reproofCoordinator: {
        settle(input) {
          reproofSettles.push(input);
          return Promise.resolve("held");
        },
      },
      // rv-16a: the persisted post-merge behavior verdict runs on the LIVE route path; stub it
      // here (the pool is a placeholder) so the retry-settlement assertions stay focused.
      behaviorVerifier: {
        verify() {
          return Promise.resolve({ decision: "noop", passed: 0, failed: 0, verdicts: [] });
        },
      },
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
      authority: {
        async authorize(input) {
          authorizations.push(input.resolutionJobId);
          return {
            id: "rdec_retry",
            decision: "authorized",
            inputSnapshotHash: "sha256:" + "a".repeat(64),
            reasons: [],
            created: true,
          };
        },
      },
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
        async verifyActiveLease(input) {
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
            attempt: 1,
          };
        },
        async complete(input) {
          completed.push(`${input.id}:${input.leaseOwner}`);
          return true;
        },
        async release(input) {
          released.push(input);
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
              return verdict;
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
    const authorizations: string[] = [];
    const response = await appFor(enqueued, executed, completed, [], VERDICT, authorizations).request(
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
        attempt: 1,
      }),
    ]);
    expect(completed).toEqual(["rjob_manual_1:route_lease_1"]);
    expect(authorizations).toEqual(["rjob_manual_1"]);
  });

  it("returns an inconclusive production verification job to retryable instead of completing it", async () => {
    const completed: string[] = [];
    const released: unknown[] = [];
    const authorizations: string[] = [];
    const response = await appFor([], [], completed, released, INCONCLUSIVE_VERDICT, authorizations).request(
      "/v1/orgs/org_acme/projects/project_1/issue-loops/loop_1/retry-verification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractId: "contract_1",
          releaseInstanceId: "release_1",
          idempotencyKey: "operator-retry-inconclusive",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ verdict: INCONCLUSIVE_VERDICT });
    expect(completed).toEqual([]);
    expect(released).toEqual([expect.objectContaining({ id: "rjob_manual_1", state: "retryable" })]);
    expect(authorizations).toEqual(["rjob_manual_1"]);
  });

  it("routes a product_failure retry through the rv-19 deploy-side rollback settlement", async () => {
    const reproofSettles: SettleReproofInput[] = [];
    const response = await appFor([], [], [], [], FAILURE_VERDICT, [], reproofSettles).request(
      "/v1/orgs/org_acme/projects/project_1/issue-loops/loop_1/retry-verification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractId: "contract_1",
          releaseInstanceId: "release_1",
          idempotencyKey: "operator-retry-failure",
        }),
      },
    );

    expect(response.status).toBe(200);
    // The retry path MUST invoke the same deploy-side settlement the walker does — a
    // product_failure here can never complete with the broken release left live.
    expect(reproofSettles).toEqual([
      expect.objectContaining({
        orgId: "org_acme",
        projectId: "project_1",
        releaseInstanceId: "release_1",
        result: FAILURE_VERDICT,
      }),
    ]);
  });
});

// rv-17: the operator-retry route is the SECOND production bisection call site. It must consult the
// quarantine reader too so a quarantined (flaky) behavior's regressed verdict is never bisected here.
function appForBisection(opts: { isQuarantined: boolean; bisectCalls: string[] }) {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ACTOR);
    await next();
  });
  const job = {
    orgId: "org_acme",
    projectId: "project_1",
    issueLoopId: "loop_1",
    contractId: "contract_1",
    releaseInstanceId: "release_1",
    stage: "production" as const,
    state: "running" as const,
    leaseOwner: "route_lease_1",
    leaseExpiry: "2026-07-17T19:00:00.000Z",
    idempotencyKey: "operator-retry-quarantine",
    attempt: 1,
  };
  app.route(
    "/v1/orgs",
    createProductionVerificationRoutes({
      pool: {} as never,
      reproofCoordinator: { settle: () => Promise.resolve("held") },
      // A REGRESSED post-merge behavior verdict — without the quarantine guard this WOULD bisect.
      behaviorVerifier: {
        verify() {
          return Promise.resolve({
            decision: "recorded" as const,
            passed: 0,
            failed: 1,
            verdicts: [{ behaviorRevisionId: "br_flaky", verdictId: "v_reg", outcome: "failed_product" as const }],
          });
        },
      },
      regressionBisector: {
        bisect(trigger) {
          opts.bisectCalls.push(trigger.behaviorRevisionId);
          return Promise.resolve({ status: "inconclusive" } as BisectionResult);
        },
      },
      behaviorQuarantineReader: { isQuarantined: () => Promise.resolve(opts.isQuarantined) },
      contracts: {
        async get() {
          return contract;
        },
      },
      releaseById: async () => ({ projectId: "project_1", environment: "production", state: "live" }),
      enqueue: {
        async enqueue() {
          return { id: "rjob_manual_1", created: true };
        },
      },
      jobId: () => "rjob_manual_1",
      executionLeaseOwner: () => "route_lease_1",
      authority: {
        async authorize() {
          return {
            id: "rdec_retry",
            decision: "authorized" as const,
            inputSnapshotHash: "sha256:" + "a".repeat(64),
            reasons: [],
            created: true,
          };
        },
      },
      jobs: {
        async claimById(input) {
          return { ...job, id: input.id, orgId: input.orgId, leaseOwner: input.leaseOwner };
        },
        async verifyActiveLease(input) {
          return { ...job, id: input.id, orgId: input.orgId, leaseOwner: input.leaseOwner };
        },
        async complete() {
          return true;
        },
        async release() {
          return true;
        },
      },
      stages: new Map<ResolutionStageKind, ResolutionStage>([
        ["production", { kind: "production", run: () => Promise.resolve(VERDICT) }],
      ]),
    }),
  );
  return app;
}

async function retryBisection(app: Hono<ActorContextEnv>) {
  return app.request("/v1/orgs/org_acme/projects/project_1/issue-loops/loop_1/retry-verification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contractId: "contract_1",
      releaseInstanceId: "release_1",
      idempotencyKey: "operator-retry-quarantine",
    }),
  });
}

describe("production verification retry route — rv-17 quarantine-aware bisection", () => {
  it("DECISIVE: a QUARANTINED behavior's regressed verdict is NOT bisected on the operator-retry path", async () => {
    const bisectCalls: string[] = [];
    const response = await retryBisection(appForBisection({ isQuarantined: true, bisectCalls }));
    expect(response.status).toBe(200);
    expect(bisectCalls).toEqual([]);
  });

  it("a NON-quarantined regressed behavior IS bisected on the operator-retry path", async () => {
    const bisectCalls: string[] = [];
    const response = await retryBisection(appForBisection({ isQuarantined: false, bisectCalls }));
    expect(response.status).toBe(200);
    expect(bisectCalls).toEqual(["br_flaky"]);
  });
});
