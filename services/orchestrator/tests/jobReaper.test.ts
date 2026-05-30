// P3-0028: the reaper requeues expired leases and dead-letters exhausted ones,
// emitting a `job.dead_lettered` lifecycle event for each dead letter.

import { describe, expect, it } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { reapExpiredJobs } from "../src/engine/worker/jobReaper.js";

// RLS R3a-worker: the reaper now resolves a reaped run's lineage (incl. org_id,
// to scope the dead-letter event) under `runWithSystemScope`, so this fake gains
// `connect()` + transaction-control handling. The SELECT also carries `org_id`
// (returned NULL here — the dead-letter event then appends on the pool, the
// inert path the FakeEventStore observes unchanged).
class ReaperPool {
  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT spec_id, project_id, org_id FROM runs")) {
      return {
        rows: [{ spec_id: `spec_for_${String(params[0])}`, project_id: "project_1", org_id: null }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return this;
  }

  release(): void {}

  asPgPool() {
    return this as never;
  }
}

describe("job reaper (P3-0028)", () => {
  it("requeues an expired-lease job that still has retry budget — no dead-letter event", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, maxAttempts: 3 });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      pool: new ReaperPool().asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toMatchObject({ requeued: 1, deadLettered: 0 });
    expect(events.events).toEqual([]);
    // Requeued → claimable again.
    expect(await jobQueue.claim("plan")).toMatchObject({ runId: "run_1", attempts: 2 });
  });

  it("dead-letters an exhausted-budget job and emits job.dead_lettered", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, maxAttempts: 1 });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      pool: new ReaperPool().asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toMatchObject({ requeued: 0, deadLettered: 1 });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      eventType: "job.dead_lettered",
      runId: "run_1",
      specId: "spec_for_run_1",
      projectId: "project_1",
      payload: { taskKind: "plan", attempts: 1, maxAttempts: 1, failureKind: "lease_expired" },
    });
    // Terminal — never re-claimed.
    expect(await jobQueue.claim("plan")).toBeUndefined();
  });

  it("is a no-op when no lease has expired", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 60_000 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      pool: new ReaperPool().asPgPool(),
      jobQueue,
      eventStore: events,
    });

    expect(result).toMatchObject({ requeued: 0, deadLettered: 0, jobs: [] });
    expect(events.events).toEqual([]);
  });
});
