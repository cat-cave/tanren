// the reaper requeues EVERY expired lease (unbounded — no attempt-cap
// dead-letter; a re-claim is recovery, not a strike), emitting a LOUD
// `job.lease_expired` infra signal for each so a repeatedly-crashing worker
// surfaces for triage.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeJobQueue } from "../src/engine/contracts/jobQueue.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { JobReaper, reapExpiredJobs } from "../src/engine/worker/jobReaper.js";

// RLS R3a-worker: the reaper resolves a reaped run's lineage (incl. org_id, to
// scope the lease-expiry event) under `runWithSystemScope`, so this fake gains
// `connect()` + transaction-control handling. The SELECT also carries `org_id`
// — NULL by default (the event then appends on the pool, the inert path) or a
// configured org (the event appends under `runWithJobOrgId`). When `missingRun`
// is set the lineage SELECT returns no row, so the reaper skips the event (the
// run is gone).
class ReaperPool {
  constructor(private readonly opts: { orgId?: string | null; missingRun?: boolean } = {}) {}

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT spec_id, project_id, org_id FROM runs")) {
      if (this.opts.missingRun === true) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            spec_id: `spec_for_${String(params[0])}`,
            project_id: "project_1",
            org_id: this.opts.orgId ?? null,
          },
        ],
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("job reaper", () => {
  it("requeues an expired-lease job AND emits a job.lease_expired infra signal", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      // v68 fix: events.org_id is NOT NULL; a null-org reaped job SKIPS event emit.
      // The test asserts events fire → seed a tenant org on the run lineage.
      pool: new ReaperPool({ orgId: "org_reaper" }).asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toMatchObject({ requeued: 1, eventWriteFailed: 0 });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      eventType: "job.lease_expired",
      runId: "run_1",
      specId: "spec_for_run_1",
      projectId: "project_1",
      payload: { taskKind: "plan", attempts: 1, failureKind: "lease_expired" },
    });
    // Requeued → claimable again, attempt count climbs (diagnostic, not a budget).
    expect(await jobQueue.claim("plan")).toMatchObject({ runId: "run_1", attempts: 2 });
  });

  it("requeues INDEFINITELY — a job re-claimed many times never dead-letters on a count", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_loop", taskKind: "plan", payload: {} });
    const events = new FakeEventStore();
    // v68 fix: events.org_id is NOT NULL; a null-org reaped job SKIPS event emit.
    const pool = new ReaperPool({ orgId: "org_reaper" }).asPgPool();

    // Burn through far more re-claims than any old cap (DEFAULT_MAX_ATTEMPTS was 5):
    // every lease-expiry must requeue, never give up. A crashing worker is loud
    // INFRA, not a job to drop.
    for (let i = 1; i <= 12; i += 1) {
      const claimed = await jobQueue.claim("plan", { leaseMs: 10 });
      expect(claimed).toMatchObject({ attempts: i });
      const result = await reapExpiredJobs({
        pool,
        jobQueue,
        eventStore: events,
        now: new Date(Date.now() + 1_000),
      });
      expect(result.requeued).toBe(1);
    }

    // Still alive after 12 re-claims — never terminal, and 12 loud signals fired.
    expect(events.events).toHaveLength(12);
    expect(await jobQueue.claim("plan")).toMatchObject({ runId: "run_loop", attempts: 13 });
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

    expect(result).toMatchObject({ requeued: 0, jobs: [] });
    expect(events.events).toEqual([]);
  });
});

describe("reapExpiredJobs — lineage + event scoping", () => {
  it("carries the reaped run's resolved lineage (spec/project) into the lease-expiry event", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_42", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    await reapExpiredJobs({
      // v68 fix: events.org_id is NOT NULL; a null-org reaped job SKIPS event emit.
      pool: new ReaperPool({ orgId: "org_reaper" }).asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    // specId/projectId come straight from loadRunLineage's SELECT (proving the
    // lineage read result is threaded into the event, not a constant).
    expect(events.events[0]).toMatchObject({
      runId: "run_42",
      specId: "spec_for_run_42",
      projectId: "project_1",
      payload: { message: "lease expired (worker crashed or stalled); job requeued for recovery" },
    });
  });

  it("skips the lease-expiry event when the reaped run row is gone (lineage not found)", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_gone", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      pool: new ReaperPool({ missingRun: true }).asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    // Still requeued (recovery is never blocked), but no event emitted.
    expect(result).toMatchObject({ requeued: 1 });
    expect(events.events).toEqual([]);
  });

  it("requeues an org-scoped run and still emits the event (org-scoped append path)", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_org", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    // org_id non-null → the append runs under runWithJobOrgId(orgId) rather than
    // the bare pool. The injected event store records the append either way.
    const result = await reapExpiredJobs({
      pool: new ReaperPool({ orgId: "org_77" }).asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toMatchObject({ requeued: 1 });
    expect(events.events[0]).toMatchObject({ runId: "run_org", eventType: "job.lease_expired" });
  });

  it("does not emit an event for a requeued job with no run id", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const events = new FakeEventStore();

    const result = await reapExpiredJobs({
      pool: new ReaperPool().asPgPool(),
      jobQueue,
      eventStore: events,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toMatchObject({ requeued: 1 });
    expect(events.events).toEqual([]);
  });
});

describe("reapExpiredJobs — LOUD lease-expiry signal failures (r6 §1)", () => {
  // An event store whose append always throws — the lease-expiry event write fails.
  class ThrowingEventStore extends FakeEventStore {
    override async append(): Promise<void> {
      throw new Error("events insert blew up");
    }
  }

  it("counts + logs (never swallows) a failed lease-expiry EVENT write", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_ev", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 10 });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reapExpiredJobs({
      pool: new ReaperPool({ orgId: "org_77" }).asPgPool(),
      jobQueue,
      eventStore: new ThrowingEventStore(),
      now: new Date(Date.now() + 1_000),
    });

    // Recovery still happened (job is requeued), but the lost signal is LOUD:
    // counted on the result AND structured-logged — never silently dropped.
    expect(result).toMatchObject({ requeued: 1, eventWriteFailed: 1 });
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("lease-expired event write failed");
    expect(logged).toContain("event_write_failed");
    expect(logged).toContain("run_ev");
  });
});

// A sleep the test resolves explicitly: the reaper loop parks here between
// passes, so the test controls exactly how many passes run (no busy-spin, no
// real timer — deterministic + fast). `release()` lets the loop take its next
// pass; `parked` is true while the loop is waiting in the sleep.
function gatedSleep() {
  let pending: (() => void) | undefined;
  const sleep = () =>
    new Promise<void>((resolve) => {
      pending = resolve;
    });
  return {
    sleep,
    release(): void {
      const p = pending;
      pending = undefined;
      p?.();
    },
    get parked(): boolean {
      return pending !== undefined;
    },
  };
}

describe("JobReaper loop lifecycle", () => {
  it("runs passes on the interval until stopped, then drains (no pass after stop)", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 1 });
    // Ensure the 1ms lease is expired before the reaper's first pass.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    const passes: number[] = [];
    const gate = gatedSleep();
    const reaper = new JobReaper(
      { pool: new ReaperPool().asPgPool(), jobQueue, eventStore: new FakeEventStore() },
      { intervalMs: 5, sleep: gate.sleep, onPass: (r) => passes.push(r.requeued) },
    );

    reaper.start();
    // The first pass requeues the expired job, then parks in the gated sleep.
    await vi.waitFor(() => expect(gate.parked).toBe(true));
    expect(passes).toEqual([1]);
    // Stop while parked; releasing the sleep must NOT trigger another pass.
    const stopped = reaper.stop();
    gate.release();
    await stopped;
    expect(passes).toEqual([1]);
  });

  it("start() is idempotent — a second call does not launch a second loop", async () => {
    const jobQueue = new FakeJobQueue();
    let passes = 0;
    const gate = gatedSleep();
    const reaper = new JobReaper(
      { pool: new ReaperPool().asPgPool(), jobQueue, eventStore: new FakeEventStore() },
      { intervalMs: 0, sleep: gate.sleep, onPass: () => (passes += 1) },
    );
    reaper.start();
    // no-op: must not double the loop
    reaper.start();
    // With a SINGLE loop, exactly one pass runs before parking. A doubled loop
    // would run two passes before either parked.
    await vi.waitFor(() => expect(gate.parked).toBe(true));
    expect(passes).toBe(1);
    // Release the gated sleep WHILE draining so the parked loop wakes, sees
    // draining, and exits (else `stop()` would await a parked loop forever).
    const stopped = reaper.stop();
    gate.release();
    await stopped;
    expect(passes).toBe(1);
  });

  it("survives a pass that throws (logs + continues), does not kill the loop", async () => {
    const jobQueue = new FakeJobQueue();
    // reapExpiredLeases throws on the first pass, succeeds after.
    let calls = 0;
    const original = jobQueue.reapExpiredLeases.bind(jobQueue);
    jobQueue.reapExpiredLeases = async (opts) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient DB blip");
      }
      return original(opts);
    };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    let passes = 0;
    const gate = gatedSleep();
    const reaper = new JobReaper(
      { pool: new ReaperPool().asPgPool(), jobQueue, eventStore: new FakeEventStore() },
      { intervalMs: 0, sleep: gate.sleep, onPass: () => (passes += 1) },
    );
    reaper.start();
    // Pass 1 throws (no onPass) → loop catches + parks. Release → pass 2 succeeds.
    await vi.waitFor(() => expect(gate.parked).toBe(true));
    expect(passes).toBe(0);
    gate.release();
    await vi.waitFor(() => expect(passes).toBeGreaterThan(0));
    await vi.waitFor(() => expect(gate.parked).toBe(true));
    const stopped = reaper.stop();
    gate.release();
    await stopped;

    expect(calls).toBeGreaterThan(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("transient DB blip");
  });

  it("default onPass logs only when something was requeued", async () => {
    const jobQueue = new FakeJobQueue();
    await jobQueue.enqueue({ runId: "run_1", taskKind: "plan", payload: {} });
    await jobQueue.claim("plan", { leaseMs: 1 });
    // Ensure the 1ms lease is unambiguously expired before the reaper's first
    // pass, so the requeue (and thus the default log) is deterministic.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // No onPass override → exercise the DEFAULT onPass. Pass 1 requeues the job
    // and the default logs the count; then the loop parks in the gated sleep.
    const gate = gatedSleep();
    const reaper = new JobReaper(
      { pool: new ReaperPool().asPgPool(), jobQueue, eventStore: new FakeEventStore() },
      { intervalMs: 0, sleep: gate.sleep },
    );
    reaper.start();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const stopped = reaper.stop();
    gate.release();
    await stopped;

    // The default logged the requeue count (observable effect of the pass).
    expect(log.mock.calls.flat().join(" ")).toContain('"requeued":1');
  });
});
