import { notifyJobEnqueued } from "@tanren/db";
import type pg from "pg";

export interface JobEnvelope<TPayload = unknown> {
  id: string;
  runId?: string;
  taskId?: string;
  taskKind: string;
  payload: TPayload;
  attempts: number;
  /** configured re-claim ceiling for this job. */
  maxAttempts: number;
  // RLS R3b: the owning run's org, stamped on enqueue (job_queue.org_id). The
  // queue stays OUTSIDE RLS, so this is the worker's tenant BOOTSTRAP source —
  // the claim reads it to scope `loadRunExecutionContext` to the job's org
  // instead of doing an RLS-protected `runs` read. Undefined for a
  // system / null-org job (e.g. the hello fixture, a CLI caller with no org).
  orgId?: string;
}

export type EnqueueJob<TPayload = unknown> = Omit<JobEnvelope<TPayload>, "id" | "attempts" | "maxAttempts"> & {
  attempts?: number;
  maxAttempts?: number;
};

/** queue lease default: a claimed job's lease lives this long unless renewed. */
export const DEFAULT_LEASE_MS = 60_000;
/** retry-budget default: bounded re-claim attempts before dead-lettering. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** A job the reaper recovered: either requeued (lease expired, budget left) or dead-lettered. */
export interface ReapedJob {
  id: string;
  runId?: string;
  taskKind: string;
  attempts: number;
  maxAttempts: number;
  outcome: "requeued" | "dead_lettered";
}

export interface JobQueue<TPayload = unknown> {
  enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>>;
  /** Claim one queued job. `leaseMs` sets the initial lease window (default {@link DEFAULT_LEASE_MS}). */
  claim(taskKind: string, options?: { runId?: string; leaseMs?: number }): Promise<JobEnvelope<TPayload> | undefined>;
  /** extend a claimed job's lease while the worker is still executing it. */
  heartbeat(id: string, leaseMs?: number): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, failure: { kind: string; message: string }): Promise<void>;
  failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void>;
  /**
   * lease recovery: requeue `running` jobs whose lease has lapsed
   * (crashed worker). A job that still has retry budget is returned to
   * `queued`; one that has exhausted its budget is dead-lettered. Returns the
   * jobs it acted on so the caller can emit `job.dead_lettered` events.
   */
  reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]>;
}

interface FakeJobRow<TPayload> extends JobEnvelope<TPayload> {
  status: "queued" | "running" | "done" | "failed" | "dead_letter";
  leasedUntil?: number;
  failureKind?: string;
  failureMessage?: string;
}

export class FakeJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  private readonly jobs: Array<FakeJobRow<TPayload>> = [];

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    const envelope: FakeJobRow<TPayload> = {
      ...job,
      attempts: job.attempts ?? 0,
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      id: `job_${this.jobs.length + 1}`,
      status: "queued" as const,
    };
    this.jobs.push(envelope);
    return envelopeFromRow(envelope);
  }

  async claim(
    taskKind: string,
    options?: { runId?: string; leaseMs?: number },
  ): Promise<JobEnvelope<TPayload> | undefined> {
    const job = this.jobs.find(
      (candidate) =>
        candidate.status === "queued" && candidate.taskKind === taskKind && matchesRun(candidate.runId, options?.runId),
    );
    if (job === undefined) {
      return undefined;
    }
    job.status = "running";
    job.attempts += 1;
    job.leasedUntil = Date.now() + (options?.leaseMs ?? DEFAULT_LEASE_MS);
    return envelopeFromRow(job);
  }

  async heartbeat(id: string, leaseMs?: number): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined && job.status === "running") {
      job.leasedUntil = Date.now() + (leaseMs ?? DEFAULT_LEASE_MS);
    }
  }

  async complete(id: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "done";
    }
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      job.status = "failed";
      job.failureKind = failure.kind;
      job.failureMessage = failure.message;
    }
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    for (const job of this.jobs) {
      if (job.status === "queued" && job.runId === runId) {
        job.status = "failed";
        job.failureKind = failure.kind;
        job.failureMessage = failure.message;
      }
    }
  }

  async reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]> {
    const now = (options?.now ?? new Date()).getTime();
    const reaped: ReapedJob[] = [];
    for (const job of this.jobs) {
      if (job.status !== "running" || job.leasedUntil === undefined || job.leasedUntil > now) {
        continue;
      }
      if (job.attempts >= job.maxAttempts) {
        job.status = "dead_letter";
        job.leasedUntil = undefined;
        reaped.push(reapedFromRow(job, "dead_lettered"));
      } else {
        job.status = "queued";
        job.leasedUntil = undefined;
        reaped.push(reapedFromRow(job, "requeued"));
      }
    }
    return reaped;
  }
}

export class PgJobQueue<TPayload = unknown> implements JobQueue<TPayload> {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(job: EnqueueJob<TPayload>): Promise<JobEnvelope<TPayload>> {
    // RLS R3b: stamp the owning run's org_id on the queue row. When the caller
    // does not pass one explicitly we derive it from the run (COALESCE), so a
    // run-bound job always carries its tenant even if the enqueue site predates
    // the org thread. job_queue stays OUTSIDE RLS, so this INSERT is unaffected
    // by policies — it is the worker's bootstrap source, not a tenant read.
    const result = await this.pool.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, attempts, max_attempts, org_id)
       VALUES (
         $1, $2, $3, $4::jsonb, $5, $6,
         COALESCE($7, (SELECT org_id FROM runs WHERE run_id = $1))
       )
       RETURNING id::text, run_id, task_id, task_kind, payload, attempts, max_attempts, org_id`,
      [
        job.runId ?? null,
        job.taskId ?? null,
        job.taskKind,
        JSON.stringify(job.payload),
        job.attempts ?? 0,
        job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        job.orgId ?? null,
      ],
    );
    // LISTEN/NOTIFY: wake an idle worker slot the instant a job is enqueued,
    // replacing its 1s poll as the primary driver. This INSERT is autocommit
    // (the pool), so the NOTIFY fires immediately on the cross-tenant
    // `tanren_job_queue` channel — a payload-free "work may be available" pulse.
    await notifyJobEnqueued(this.pool);
    return envelopeFromRow(result.rows[0]);
  }

  async claim(
    taskKind: string,
    options?: { runId?: string; leaseMs?: number },
  ): Promise<JobEnvelope<TPayload> | undefined> {
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
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
         SET status = 'running',
             started_at = now(),
             attempts = attempts + 1,
             heartbeat_at = now(),
             leased_until = now() + ($3 * interval '1 millisecond')
         WHERE id IN (SELECT id FROM next_job)
         RETURNING id::text, run_id, task_id, task_kind, payload, attempts, max_attempts, org_id`,
        [taskKind, options?.runId ?? null, leaseMs],
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

  async heartbeat(id: string, leaseMs?: number): Promise<void> {
    const lease = leaseMs ?? DEFAULT_LEASE_MS;
    await this.pool.query(
      `UPDATE job_queue
       SET heartbeat_at = now(), leased_until = now() + ($2 * interval '1 millisecond')
       WHERE id = $1 AND status = 'running'`,
      [id, lease],
    );
  }

  async complete(id: string): Promise<void> {
    await this.pool.query("UPDATE job_queue SET status = 'done', ended_at = now(), leased_until = NULL WHERE id = $1", [
      id,
    ]);
  }

  async fail(id: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), leased_until = NULL, failure_kind = $2, failure_message = $3
       WHERE id = $1`,
      [id, failure.kind, failure.message],
    );
  }

  async failQueuedForRun(runId: string, failure: { kind: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', ended_at = now(), failure_kind = $2, failure_message = $3
       WHERE run_id = $1 AND status = 'queued'`,
      [runId, failure.kind, failure.message],
    );
  }

  async reapExpiredLeases(options?: { now?: Date }): Promise<ReapedJob[]> {
    // Single atomic pass: any `running` job whose lease lapsed is either
    // requeued (budget remaining) or dead-lettered (budget exhausted). The
    // CASE keeps the decision server-side so a concurrent claim can't slip
    // between a read and a write.
    const now = options?.now;
    const result = await this.pool.query(
      `UPDATE job_queue
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
           leased_until = NULL,
           started_at = CASE WHEN attempts >= max_attempts THEN started_at ELSE NULL END,
           ended_at = CASE WHEN attempts >= max_attempts THEN now() ELSE ended_at END,
           failure_kind = CASE WHEN attempts >= max_attempts THEN COALESCE(failure_kind, 'lease_expired') ELSE failure_kind END,
           failure_message = CASE
             WHEN attempts >= max_attempts THEN COALESCE(failure_message, 'retry budget exhausted after lease expiry')
             ELSE failure_message
           END
       WHERE status = 'running'
         AND leased_until IS NOT NULL
         AND leased_until < ${now === undefined ? "now()" : "$1"}
       RETURNING id::text, run_id, task_kind, attempts, max_attempts, status`,
      now === undefined ? [] : [now],
    );
    return result.rows.map((row: ReapRow) => ({
      id: String(row.id),
      runId: row.run_id ?? undefined,
      taskKind: row.task_kind,
      attempts: row.attempts ?? 0,
      maxAttempts: row.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      outcome: row.status === "dead_letter" ? "dead_lettered" : "requeued",
    }));
  }
}

interface ReapRow {
  id: string | number;
  run_id?: string | null;
  task_kind: string;
  attempts?: number;
  max_attempts?: number;
  status: string;
}

function reapedFromRow<TPayload>(job: JobEnvelope<TPayload>, outcome: ReapedJob["outcome"]): ReapedJob {
  return {
    id: job.id,
    runId: job.runId,
    taskKind: job.taskKind,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    outcome,
  };
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
  max_attempts?: number;
  maxAttempts?: number;
  org_id?: string | null;
  orgId?: string | null;
}): JobEnvelope<TPayload> {
  const orgId = row.org_id ?? row.orgId ?? undefined;
  return {
    id: String(row.id),
    runId: row.run_id ?? row.runId ?? undefined,
    taskId: row.task_id ?? row.taskId ?? undefined,
    taskKind: row.task_kind ?? row.taskKind ?? "",
    payload: row.payload,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? row.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    ...(orgId === undefined || orgId === null ? {} : { orgId }),
  };
}
