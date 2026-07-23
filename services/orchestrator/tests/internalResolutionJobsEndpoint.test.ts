// cspell:ignore vassert vartifact
import { describe, expect, it } from "vitest";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import type { ResolutionJob, ResolutionStage } from "../src/engine/contracts/resolutionStage.js";
import type { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { createInternalResolutionJobRoutes } from "../src/routes/internal/resolutionJobs.js";
import { LockedBehaviorContextError } from "../src/engine/verification/resolutionStages/resolutionBehaviorContext.js";

const job: ResolutionJob = {
  id: "rjob_1",
  orgId: "org_a",
  projectId: "project_a",
  issueLoopId: "iloop_a",
  contractId: "contract_a",
  stage: "baseline",
  state: "running",
  leaseOwner: "worker_a",
  leaseExpiry: "2026-01-01T00:01:00.000Z",
  idempotencyKey: "iloop_a:baseline",
  attempt: 2,
};

function trustedRequest(app: ReturnType<typeof createInternalResolutionJobRoutes>, path: string, body: unknown) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

describe("internal resolution-job endpoints", () => {
  it("requires mTLS before calling the durable store", async () => {
    const store = {
      async claimNext() {
        throw new Error("must not be called");
      },
    } as unknown as ResolutionJobStore;
    const app = createInternalResolutionJobRoutes({ pool: {} as never, verifier: new DenyAllPeerVerifier(), store });

    const response = await trustedRequest(app, "/internal/resolution-jobs/claim", {
      orgId: "org_a",
      leaseOwner: "worker_a",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "untrusted_peer" });
  });

  it("claims and heartbeats a resolution job through the mTLS-only surface", async () => {
    const calls: string[] = [];
    const store = {
      async claimNext() {
        calls.push("claim");
        return job;
      },
      async heartbeat() {
        calls.push("heartbeat");
        return true;
      },
    } as unknown as ResolutionJobStore;
    const app = createInternalResolutionJobRoutes({ pool: {} as never, verifier: new AllowAllPeerVerifier(), store });

    const claim = await trustedRequest(app, "/internal/resolution-jobs/claim", {
      orgId: "org_a",
      leaseOwner: "worker_a",
      leaseMs: 60_000,
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ job });

    const heartbeat = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/heartbeat", {
      orgId: "org_a",
      leaseOwner: "worker_a",
      leaseMs: 60_000,
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ renewed: true });
    expect(calls).toEqual(["claim", "heartbeat"]);
  });

  it("runs the DB-fenced baseline job with the LOCKED behavior context, never a caller-supplied one", async () => {
    const lockedContext = {
      contractId: job.contractId,
      issueLoopId: job.issueLoopId,
      releaseInstanceId: "release_baseline",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      behaviors: [],
      personaRevisionIds: [],
      contextDigest: `sha256:${"a".repeat(64)}`,
    };
    const calls: Array<{ receivedJob: ResolutionJob; context: unknown }> = [];
    const baselineStage: ResolutionStage = {
      kind: "baseline",
      async run(receivedJob, context) {
        calls.push({ receivedJob, context });
        return {
          outcome: "passed",
          classification: "product_failure",
          proofGrade: "active_causal",
          verificationRunId: "vrun_baseline",
          assertionIds: ["vassert_baseline"],
          evidenceRefs: ["vartifact_baseline"],
        };
      },
    };
    const app = createInternalResolutionJobRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      baselineStage,
      behaviorContextLoader: { load: async () => lockedContext },
      store: {
        async verifyActiveLease() {
          return job;
        },
        async complete() {
          return true;
        },
        async release() {
          return true;
        },
      } as unknown as ResolutionJobStore,
    });

    // The caller MUST NOT supply a context; the schema is strict.
    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      orgId: job.orgId,
      leaseOwner: job.leaseOwner,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        outcome: "passed",
        classification: "product_failure",
        proofGrade: "active_causal",
        verificationRunId: "vrun_baseline",
        assertionIds: ["vassert_baseline"],
        evidenceRefs: ["vartifact_baseline"],
      },
    });
    // The stage received ONLY the loaded locked context — not a caller-supplied one.
    expect(calls).toEqual([{ receivedJob: job, context: { behaviorContext: lockedContext } }]);
  });

  it("fails CLOSED (terminal stale_contract, 409) when the locked behavior context cannot be loaded — the stage never runs", async () => {
    const completes: string[] = [];
    const releases: string[] = [];
    const app = createInternalResolutionJobRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      behaviorContextLoader: {
        load: () => Promise.reject(new LockedBehaviorContextError("empty_binding", "release binds no behaviors")),
      },
      baselineStage: {
        kind: "baseline",
        async run() {
          throw new Error("the baseline stage must not run on a lock failure");
        },
      },
      store: {
        async verifyActiveLease() {
          return job;
        },
        async complete() {
          completes.push(job.id);
          return true;
        },
        async release() {
          releases.push(job.id);
          return true;
        },
      } as unknown as ResolutionJobStore,
    });

    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      orgId: job.orgId,
      leaseOwner: job.leaseOwner,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "stale_behavior_contract", reason: "empty_binding" });
    // Settled TERMINAL (completed), not returned to retryable.
    expect(completes).toEqual([job.id]);
    expect(releases).toEqual([]);
  });

  it("settles TERMINAL stale_contract when the lock error is thrown from INSIDE stage.run (e.g. missing environment), not retryable", async () => {
    const lockedContext = {
      contractId: job.contractId,
      issueLoopId: job.issueLoopId,
      releaseInstanceId: "release_baseline",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      behaviors: [],
      personaRevisionIds: [],
      contextDigest: `sha256:${"a".repeat(64)}`,
    };
    const completes: string[] = [];
    const releases: string[] = [];
    const app = createInternalResolutionJobRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      // The loader SUCCEEDS; the resolver INSIDE the stage throws the lock error.
      behaviorContextLoader: { load: async () => lockedContext },
      baselineStage: {
        kind: "baseline",
        run: () =>
          Promise.reject(
            new LockedBehaviorContextError("missing_release_binding", "no ready environment for the frozen release"),
          ),
      },
      store: {
        async verifyActiveLease() {
          return job;
        },
        async complete() {
          completes.push(job.id);
          return true;
        },
        async release() {
          releases.push(job.id);
          return true;
        },
      } as unknown as ResolutionJobStore,
    });

    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      orgId: job.orgId,
      leaseOwner: job.leaseOwner,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "stale_behavior_contract",
      reason: "missing_release_binding",
    });
    // TERMINAL (completed), never released retryable — a stage-thrown lock error is not reclaimable.
    expect(completes).toEqual([job.id]);
    expect(releases).toEqual([]);
  });

  it("with the REAL loader and NO frozen release binding, fails CLOSED (missing_release_binding) before any release lookup — the baseline stage never runs", async () => {
    const completes: string[] = [];
    // `job` has no releaseInstanceId; the DEFAULT (real) loader rejects it BEFORE any
    // DB/release query, so it can never drift to a newer release by recency.
    const app = createInternalResolutionJobRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      baselineStage: {
        kind: "baseline",
        async run() {
          throw new Error("the baseline stage must not run without a frozen release binding");
        },
      },
      store: {
        async verifyActiveLease() {
          return job;
        },
        async complete() {
          completes.push(job.id);
          return true;
        },
        async release() {
          throw new Error("a stale binding is terminal — it must not be released retryable");
        },
      } as unknown as ResolutionJobStore,
    });

    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      orgId: job.orgId,
      leaseOwner: job.leaseOwner,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "stale_behavior_contract",
      reason: "missing_release_binding",
    });
    expect(completes).toEqual([job.id]);
  });

  it("refuses a stale or caller-invented reproduction job before running the stage", async () => {
    const app = createInternalResolutionJobRoutes({
      pool: {} as never,
      verifier: new AllowAllPeerVerifier(),
      store: {
        async verifyActiveLease() {},
      } as unknown as ResolutionJobStore,
      baselineStage: {
        kind: "baseline",
        async run() {
          throw new Error("a stale lease must not invoke the stage");
        },
      },
    });

    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      orgId: job.orgId,
      leaseOwner: "expired_worker",
    });

    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toEqual({ error: "resolution_job_lease_not_active" });
  });
});
