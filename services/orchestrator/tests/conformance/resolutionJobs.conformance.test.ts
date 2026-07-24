import { describe, expect, it } from "vitest";
import { ResolutionJobStore } from "../../src/engine/repositories/resolutionJobs.js";
import { MemoryDb } from "./conformanceMemoryDb.js";
import { ResolutionJobScopedClient } from "./resolutionJobMemoryDb.js";

const ORG_A = "org_resolution_a";
const ORG_B = "org_resolution_b";
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("ResolutionJobStore postgres SQL conformance", () => {
  it("idempotently enqueues, leases once, heartbeats, recovers once, and preserves org isolation", async () => {
    const db = new MemoryDb();
    let observedAt = NOW;
    const store = new ResolutionJobStore({} as never);
    const orgA = new ResolutionJobScopedClient(db, ORG_A, () => observedAt);
    const orgB = new ResolutionJobScopedClient(db, ORG_B, () => observedAt);
    const input = {
      orgId: ORG_A,
      projectId: "project_resolution_a",
      id: "rjob_a",
      issueLoopId: "iloop_a",
      contractId: "contract_a",
      stage: "baseline" as const,
      idempotencyKey: "issue:iloop_a:baseline",
    };

    await expect(store.enqueueOnClient(orgA as never, input)).resolves.toEqual({ id: "rjob_a", created: true });
    await expect(store.enqueueOnClient(orgA as never, { ...input, id: "ignored_repeat_id" })).resolves.toEqual({
      id: "rjob_a",
      created: false,
    });

    const [first, second] = await Promise.all([
      store.claimNextOnClient(orgA as never, { orgId: ORG_A, leaseOwner: "worker-a", leaseMs: 30_000 }),
      store.claimNextOnClient(orgA as never, { orgId: ORG_A, leaseOwner: "worker-b", leaseMs: 30_000 }),
    ]);
    const claimed = [first, second].filter((job) => job !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: "rjob_a", state: "running", leaseOwner: "worker-a", attempt: 1 });
    expect(claimed[0]?.leaseExpiry).toBe("2026-01-01T00:00:30.000Z");

    await expect(
      store.heartbeatOnClient(orgA as never, { orgId: ORG_A, id: "rjob_a", leaseOwner: "worker-a", leaseMs: 60_000 }),
    ).resolves.toBe(true);

    observedAt = new Date("2026-01-01T00:01:01.000Z");
    const recovered = await store.recoverExpiredLeasesOnClient(orgA as never, {
      orgId: ORG_A,
      leaseOwner: "recovery-worker",
      leaseMs: 30_000,
    });
    expect(recovered).toMatchObject([{ id: "rjob_a", leaseOwner: "recovery-worker", attempt: 1 }]);
    await expect(
      store.recoverExpiredLeasesOnClient(orgA as never, {
        orgId: ORG_A,
        leaseOwner: "second-recovery-worker",
      }),
    ).resolves.toEqual([]);
    await expect(
      store.completeOnClient(orgA as never, { orgId: ORG_A, id: "rjob_a", leaseOwner: "recovery-worker" }),
    ).resolves.toBe(true);

    const foreignRows = await orgB.query("SELECT id FROM resolution_jobs WHERE org_id = $1 ORDER BY id", [ORG_A]);
    expect(foreignRows.rowCount).toBe(0);
    await expect(
      store.claimNextOnClient(orgB as never, { orgId: ORG_A, leaseOwner: "foreign-worker" }),
    ).resolves.toBeUndefined();
  });

  it("shares active-lease predicates between the production SQL and conformance fake", async () => {
    const db = new MemoryDb();
    let observedAt = NOW;
    const store = new ResolutionJobStore({} as never);
    const client = new ResolutionJobScopedClient(db, ORG_A, () => observedAt);
    const input = {
      orgId: ORG_A,
      projectId: "project_resolution_a",
      id: "rjob_fenced",
      issueLoopId: "iloop_a",
      contractId: "contract_a",
      stage: "baseline" as const,
      idempotencyKey: "issue:iloop_a:fenced",
    };
    await store.enqueueOnClient(client as never, input);
    await store.claimNextOnClient(client as never, { orgId: ORG_A, leaseOwner: "worker-a", leaseMs: 30_000 });
    observedAt = new Date("2026-01-01T00:00:31.000Z");
    const beforeLateMutation = { ...db.resolutionJobs[0] };

    await expect(
      store.verifyActiveLeaseOnClient(client as never, {
        orgId: ORG_A,
        id: input.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.completeOnClient(client as never, { orgId: ORG_A, id: input.id, leaseOwner: "worker-a" }),
    ).resolves.toBe(false);
    await expect(
      store.releaseOnClient(client as never, { orgId: ORG_A, id: input.id, leaseOwner: "worker-a" }),
    ).resolves.toBe(false);
    expect(db.resolutionJobs[0]).toEqual(beforeLateMutation);

    await store.enqueueOnClient(client as never, {
      ...input,
      id: "rjob_unexpired_release",
      idempotencyKey: "issue:iloop_a:unexpired-release",
    });
    await expect(
      store.claimNextOnClient(client as never, { orgId: ORG_A, leaseOwner: "worker-release", leaseMs: 30_000 }),
    ).resolves.toMatchObject({ id: "rjob_unexpired_release", leaseOwner: "worker-release" });
    await expect(
      store.releaseOnClient(client as never, {
        orgId: ORG_A,
        id: "rjob_unexpired_release",
        leaseOwner: "worker-release",
        state: "retryable",
      }),
    ).resolves.toBe(true);
    expect(db.resolutionJobs.find((job) => job.id === "rjob_unexpired_release")).toMatchObject({
      state: "retryable",
      lease_owner: null,
      lease_expiry: null,
    });
  });
});
