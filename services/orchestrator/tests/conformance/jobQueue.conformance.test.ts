// Per-implementation invocations of the JobQueue conformance suite. The
// in-memory FakeJobQueue and the Postgres PgJobQueue are run through the SAME
// behavior spec. PgJobQueue is driven by `MemoryJobQueuePool`, an in-memory
// `pg.Pool` substitute that implements the exact SQL statements PgJobQueue
// emits with real state semantics (so the queue contract — atomic claim,
// terminal complete/fail — is exercised end to end without a live database).
import { PgJobQueue, FakeJobQueue, DEFAULT_MAX_ATTEMPTS } from "../../src/engine/contracts/jobQueue.js";
import type { JobQueue } from "../../src/engine/contracts/jobQueue.js";
import { describeJobQueueConformance } from "./jobQueueConformance.js";

interface JobRow {
  id: number;
  run_id: string | null;
  task_id: string | null;
  task_kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  status: string;
}

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

function envelopeRow(row: JobRow): Record<string, unknown> {
  return {
    id: String(row.id),
    run_id: row.run_id,
    task_id: row.task_id,
    task_kind: row.task_kind,
    payload: row.payload,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
  };
}

/**
 * In-memory `pg.Pool`/`pg.PoolClient` substitute for PgJobQueue. It does not
 * parse arbitrary SQL — it recognizes the fixed set of statements PgJobQueue
 * emits (matched by distinctive substrings) and applies the same state
 * transitions Postgres would, so the conformance spec sees real queue
 * behavior. `connect()` hands back `this` so the claim transaction
 * (BEGIN/UPDATE/COMMIT) mutates the shared store.
 */
class MemoryJobQueuePool {
  private readonly jobs: JobRow[] = [];
  private seq = 0;

  async connect(): Promise<MemoryJobQueuePool> {
    return this;
  }

  release(): void {}

  asPgPool(): never {
    return this as never;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (sql.includes("INSERT INTO job_queue")) {
      return this.enqueue(params);
    }
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      return this.claim(params);
    }
    if (sql.includes("SET status = 'done'")) {
      return this.setStatusById(params[0], "done");
    }
    if (sql.includes("status = 'failed'") && sql.includes("WHERE run_id = $1 AND status = 'queued'")) {
      return this.failQueuedForRun(params[0]);
    }
    if (sql.includes("status = 'failed'")) {
      return this.setStatusById(params[0], "failed");
    }
    // BEGIN / COMMIT / ROLLBACK and anything else: no-op.
    return { rows: [], rowCount: 0 };
  }

  private enqueue(params: unknown[]): QueryResult {
    this.seq += 1;
    const row: JobRow = {
      id: this.seq,
      run_id: (params[0] as string | null) ?? null,
      task_id: (params[1] as string | null) ?? null,
      task_kind: params[2] as string,
      payload: JSON.parse(params[3] as string),
      attempts: (params[4] as number) ?? 0,
      max_attempts: (params[5] as number) ?? DEFAULT_MAX_ATTEMPTS,
      status: "queued",
    };
    this.jobs.push(row);
    return { rows: [envelopeRow(row)], rowCount: 1 };
  }

  private claim(params: unknown[]): QueryResult {
    const taskKind = params[0] as string;
    const runId = (params[1] as string | null) ?? null;
    const job = this.jobs.find(
      (candidate) =>
        candidate.status === "queued" &&
        candidate.task_kind === taskKind &&
        (runId === null || candidate.run_id === runId),
    );
    if (job === undefined) {
      return { rows: [], rowCount: 0 };
    }
    job.status = "running";
    job.attempts += 1;
    return { rows: [envelopeRow(job)], rowCount: 1 };
  }

  private setStatusById(id: unknown, status: string): QueryResult {
    const job = this.jobs.find((candidate) => candidate.id === Number(id));
    if (job !== undefined) {
      job.status = status;
    }
    return { rows: [], rowCount: job === undefined ? 0 : 1 };
  }

  private failQueuedForRun(runId: unknown): QueryResult {
    let count = 0;
    for (const job of this.jobs) {
      if (job.status === "queued" && job.run_id === runId) {
        job.status = "failed";
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }
}

// --- FakeJobQueue -----------------------------------------------------------
describeJobQueueConformance("FakeJobQueue", {
  make: (): JobQueue<{ n: number }> => new FakeJobQueue<{ n: number }>(),
});

// --- PgJobQueue (in-memory pool) --------------------------------------------
describeJobQueueConformance("PgJobQueue", {
  make: (): JobQueue<{ n: number }> => new PgJobQueue<{ n: number }>(new MemoryJobQueuePool().asPgPool()),
});
