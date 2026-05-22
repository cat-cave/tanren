import type pg from "pg";

export interface JobEnvelope<TPayload = unknown> {
  id: string;
  runId?: string;
  taskId?: string;
  taskKind: string;
  payload: TPayload;
  attempts: number;
}

export type EnqueueJob<TPayload = unknown> = Omit<JobEnvelope<TPayload>, "id" | "attempts"> & { attempts?: number };

export interface JobQueue<TPayload = unknown> {
  enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>>;
  claim(taskKind: string, options?: { runId?: string }): Promise<JobEnvelope<TPayload> | undefined>;
  complete(id: string): Promise<void>;
  fail(id: string, failure: { kind: string; message: string }): Promise<void>;
  failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void>;
}

export class FakeJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  private readonly jobs: Array<JobEnvelope<TPayload> & { status: "queued" | "running" | "done" | "failed" }> = [];

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    const envelope = { ...job, attempts: job.attempts ?? 0, id: `job_${this.jobs.length + 1}`, status: "queued" as const };
    this.jobs.push(envelope);
    return envelope;
  }

  async claim(taskKind: string, options?: { runId?: string }): Promise<JobEnvelope<TPayload> | undefined> {
    const job = this.jobs.find(
      (candidate) => candidate.status === "queued" && candidate.taskKind === taskKind && matchesRun(candidate.runId, options?.runId)
    );
    if (job === undefined) {
      return undefined;
    }
    job.status = "running";
    job.attempts += 1;
    return envelopeFromRow(job);
  }

  async complete(id: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "done";
    }
  }

  async fail(id: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "failed";
    }
  }

  async failQueuedForRun(runId: string): Promise<void> {
    for (const job of this.jobs) {
      if (job.status === "queued" && job.runId === runId) {
        job.status = "failed";
      }
    }
  }
}

export class PgJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    const result = await this.pool.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, attempts)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id::text, run_id, task_id, task_kind, payload, attempts`,
      [job.runId ?? null, job.taskId ?? null, job.taskKind, JSON.stringify(job.payload), job.attempts ?? 0]
    );
    return envelopeFromRow(result.rows[0]);
  }

  async claim(taskKind: string, options?: { runId?: string }): Promise<JobEnvelope<TPayload> | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH next_job AS (
           SELECT id
           FROM job_queue
           WHERE task_kind = $1
             AND status = 'queued'
             AND ($2::text IS NULL OR run_id = $2)
           ORDER BY enqueued_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE job_queue
         SET status = 'running', started_at = now(), attempts = attempts + 1
         WHERE id IN (SELECT id FROM next_job)
         RETURNING id::text, run_id, task_id, task_kind, payload, attempts`,
        [taskKind, options?.runId ?? null]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? undefined : envelopeFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(id: string): Promise<void> {
    await this.pool.query("UPDATE job_queue SET status = 'done', ended_at = now() WHERE id = $1", [id]);
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), failure_kind = $2, failure_message = $3
       WHERE id = $1`,
      [id, failure.kind, failure.message]
    );
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), failure_kind = $2, failure_message = $3
       WHERE run_id = $1 AND status = 'queued'`,
      [runId, failure.kind, failure.message]
    );
  }
}

function matchesRun(jobRunId: string | undefined, requestedRunId: string | undefined): boolean {
  return requestedRunId === undefined || jobRunId === requestedRunId;
}

function envelopeFromRow<TPayload>(row: {
  id: string | number;
  run_id?: string | null;
  runId?: string | null;
  task_id?: string | null;
  taskId?: string | null;
  task_kind?: string;
  taskKind?: string;
  payload: TPayload;
  attempts?: number;
}): JobEnvelope<TPayload> {
  return {
    id: String(row.id),
    runId: row.run_id ?? row.runId ?? undefined,
    taskId: row.task_id ?? row.taskId ?? undefined,
    taskKind: row.task_kind ?? row.taskKind ?? "",
    payload: row.payload,
    attempts: row.attempts ?? 0
  };
}
