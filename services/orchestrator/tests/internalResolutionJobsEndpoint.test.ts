// cspell:ignore vassert vartifact
import { describe, expect, it } from "vitest";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/mtlsChannel.js";
import type { ResolutionJob, ResolutionStage } from "../src/engine/contracts/resolutionStage.js";
import type { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { createInternalResolutionJobRoutes } from "../src/routes/internal/resolutionJobs.js";

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

  it("runs a claimed baseline job through the mTLS-only reproduction surface", async () => {
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
    });

    const response = await trustedRequest(app, "/internal/resolution-jobs/rjob_1/reproduce", {
      job,
      context: { verificationRunId: "vrun_baseline" },
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
    expect(calls).toEqual([{ receivedJob: job, context: { verificationRunId: "vrun_baseline" } }]);
  });
});
