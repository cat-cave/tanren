import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ATTEMPTS, FakeJobQueue, PgJobQueue } from "../src/engine/contracts/jobQueue.js";

describe("job queue", () => {
  it("enqueues, claims, completes, fails, and does not double-claim fake jobs", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    const first = await queue.enqueue({
      runId: "run_1",
      taskId: "task_1",
      taskKind: "plan",
      payload: { ok: true },
    });
    const second = await queue.enqueue({
      runId: "run_1",
      taskId: "task_2",
      taskKind: "plan",
      payload: { ok: true },
    });

    expect(first).toMatchObject({ id: "job_1", attempts: 0 });
    expect(await queue.claim("plan", { runId: "other" })).toBeUndefined();
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_1",
      taskId: "task_1",
      attempts: 1,
    });
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_2",
      taskId: "task_2",
      attempts: 1,
    });
    expect(await queue.claim("plan", { runId: "run_1" })).toBeUndefined();

    await queue.complete(first.id);
    await queue.fail(second.id, { kind: "test_failed", message: "failed" });
    await queue.failQueuedForRun("run_1", { kind: "run_failed", message: "failed run" });
  });

  it("claims one queued Postgres job with row locking", async () => {
    const client = new RecordingClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            id: "7",
            run_id: "run_1",
            task_id: "task_1",
            task_kind: "write",
            payload: { ok: true },
            attempts: 1,
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
    ]);
    const pool = new RecordingPool(client);
    const queue = new PgJobQueue<{ ok: boolean }>(pool.asPgPool());

    const job = await queue.claim("write", { runId: "run_1" });

    expect(job).toEqual({
      id: "7",
      runId: "run_1",
      taskId: "task_1",
      taskKind: "write",
      payload: { ok: true },
      attempts: 1,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    expect(client.sql).toContain("BEGIN");
    expect(client.sql[1]).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.sql[1]).toContain("SET status = 'running'");
    // P3-0028: the claim stamps a heartbeat + lease window.
    expect(client.sql[1]).toContain("leased_until = now() +");
    expect(client.sql).toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("records completion and failure state in Postgres", async () => {
    const pool = new RecordingPool();
    const queue = new PgJobQueue(pool.asPgPool());

    await queue.complete("3");
    await queue.fail("4", { kind: "writer_failed", message: "cannot write" });
    await queue.failQueuedForRun("run_1", { kind: "run_failed", message: "failed run" });

    expect(pool.sql[0]).toContain("SET status = 'done'");
    expect(pool.sql[1]).toContain("SET status = 'failed'");
    expect(pool.params[1]).toEqual(["4", "writer_failed", "cannot write"]);
    expect(pool.sql[2]).toContain("WHERE run_id = $1 AND status = 'queued'");
    expect(pool.params[2]).toEqual(["run_1", "run_failed", "failed run"]);
  });
});

describe("job queue lease recovery (P3-0028)", () => {
  it("requeues a job whose lease expired while it still has retry budget", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({
      runId: "run_1",
      taskKind: "plan",
      payload: { ok: true },
      maxAttempts: 3,
    });
    const claimed = await queue.claim("plan", { leaseMs: 10 });
    expect(claimed).toMatchObject({ attempts: 1, maxAttempts: 3 });

    // Lease has lapsed (now is past leased_until) and a worker can't be holding it.
    const reaped = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });
    expect(reaped).toEqual([
      {
        id: claimed!.id,
        runId: "run_1",
        taskKind: "plan",
        attempts: 1,
        maxAttempts: 3,
        outcome: "requeued",
      },
    ]);
    // Requeued → re-claimable, and the attempt count keeps climbing.
    const reclaimed = await queue.claim("plan", { leaseMs: 10 });
    expect(reclaimed).toMatchObject({ id: claimed!.id, attempts: 2 });
  });

  it("dead-letters a job once its retry budget is exhausted instead of requeueing", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({
      runId: "run_1",
      taskKind: "plan",
      payload: { ok: true },
      maxAttempts: 2,
    });

    // Burn the budget: claim → lease expire → reap, twice.
    await queue.claim("plan", { leaseMs: 10 });
    expect((await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) }))[0]?.outcome).toBe("requeued");
    await queue.claim("plan", { leaseMs: 10 });
    const final = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });

    expect(final).toEqual([
      {
        id: "job_1",
        runId: "run_1",
        taskKind: "plan",
        attempts: 2,
        maxAttempts: 2,
        outcome: "dead_lettered",
      },
    ]);
    // Dead-lettered → terminal, never re-claimed.
    expect(await queue.claim("plan")).toBeUndefined();
  });

  it("does not reap a job whose lease is still fresh (heartbeat keeps it alive)", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: { ok: true } });
    const claimed = await queue.claim("plan", { leaseMs: 50 });
    await queue.heartbeat(claimed!.id, 10_000);

    // now is past the ORIGINAL lease but inside the heartbeat-renewed window.
    const reaped = await queue.reapExpiredLeases({ now: new Date(Date.now() + 1_000) });
    expect(reaped).toEqual([]);
    // Still held → not claimable by another slot.
    expect(await queue.claim("plan")).toBeUndefined();
  });

  it("emits the lease-aware claim + reaper SQL through Postgres", async () => {
    const pool = new RecordingPool(
      new RecordingClient([
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
      ]),
    );
    const queue = new PgJobQueue(pool.asPgPool());

    await queue.heartbeat("9", 30_000);
    await queue.reapExpiredLeases();

    expect(pool.sql[0]).toContain("heartbeat_at = now()");
    expect(pool.sql[0]).toContain("status = 'running'");
    const reapSql = pool.sql[1] ?? "";
    expect(reapSql).toContain("attempts >= max_attempts THEN 'dead_letter'");
    expect(reapSql).toContain("ELSE 'queued'");
    expect(reapSql).toContain("leased_until < now()");
  });
});

class RecordingPool {
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];

  constructor(private readonly client = new RecordingClient()) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.sql.push(sql);
    this.params.push(params);
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<RecordingClient> {
    return this.client;
  }

  asPgPool() {
    return this as never;
  }
}

class RecordingClient {
  readonly sql: string[] = [];
  released = false;

  constructor(private readonly results: Array<{ rows: unknown[]; rowCount: number }> = []) {}

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.sql.push(sql);
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}
