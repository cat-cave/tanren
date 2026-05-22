import { describe, expect, it } from "vitest";
import { FakeJobQueue, PgJobQueue } from "../src/engine/contracts/jobQueue.js";

describe("job queue", () => {
  it("enqueues, claims, completes, fails, and does not double-claim fake jobs", async () => {
    const queue = new FakeJobQueue<{ ok: boolean }>();
    const first = await queue.enqueue({ runId: "run_1", taskId: "task_1", taskKind: "plan", payload: { ok: true } });
    const second = await queue.enqueue({ runId: "run_1", taskId: "task_2", taskKind: "plan", payload: { ok: true } });

    expect(first).toMatchObject({ id: "job_1", attempts: 0 });
    expect(await queue.claim("plan", { runId: "other" })).toBeUndefined();
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_1",
      taskId: "task_1",
      attempts: 1
    });
    await expect(queue.claim("plan", { runId: "run_1" })).resolves.toMatchObject({
      id: "job_2",
      taskId: "task_2",
      attempts: 1
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
        rows: [{ id: "7", run_id: "run_1", task_id: "task_1", task_kind: "write", payload: { ok: true }, attempts: 1 }],
        rowCount: 1
      },
      { rows: [], rowCount: 0 }
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
      attempts: 1
    });
    expect(client.sql).toContain("BEGIN");
    expect(client.sql[1]).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.sql[1]).toContain("SET status = 'running'");
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
