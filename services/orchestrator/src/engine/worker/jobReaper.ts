// P3-0028 queue lease recovery. A crashed worker leaves its claimed job
// `running` with a lease it can no longer renew. The reaper periodically sweeps
// expired leases: jobs with retry budget remaining go back to `queued` (so a
// healthy worker re-claims them), and jobs that have exhausted their bounded
// re-claim budget are moved to the terminal `dead_letter` state and surfaced
// via a `job.dead_lettered` lifecycle event for operator triage.
//
// This file OWNS the recovery side of the queue (the reaper loop + dead-letter
// event emission); the worker heartbeat that keeps a live job's lease fresh
// lives alongside the executor. P3-0029 observability stays OUT of here.

import type pg from "pg";
import type { JobQueue, ReapedJob } from "../contracts/jobQueue.js";
import { type EventStore, PgEventStore } from "../eventStore.js";

export interface ReapJobsDeps {
  pool: pg.Pool;
  jobQueue: JobQueue;
  eventStore?: EventStore;
  now?: Date;
}

export interface ReapJobsResult {
  requeued: number;
  deadLettered: number;
  jobs: ReapedJob[];
}

/**
 * Run one reaper pass: requeue or dead-letter every `running` job whose lease
 * has lapsed. Emits a `job.dead_lettered` event for each dead-lettered job that
 * is bound to a run (best-effort — never lets an event write mask the recovery).
 */
export async function reapExpiredJobs(deps: ReapJobsDeps): Promise<ReapJobsResult> {
  const reaped = await deps.jobQueue.reapExpiredLeases(deps.now === undefined ? undefined : { now: deps.now });
  const eventStore = deps.eventStore ?? new PgEventStore(deps.pool);
  let requeued = 0;
  let deadLettered = 0;
  for (const job of reaped) {
    if (job.outcome === "requeued") {
      requeued += 1;
      continue;
    }
    deadLettered += 1;
    await emitDeadLetterEvent(deps.pool, eventStore, job).catch(() => undefined);
  }
  return { requeued, deadLettered, jobs: reaped };
}

async function emitDeadLetterEvent(pool: pg.Pool, eventStore: EventStore, job: ReapedJob): Promise<void> {
  if (job.runId === undefined) {
    return;
  }
  const context = await loadRunLineage(pool, job.runId);
  if (context === undefined) {
    return;
  }
  await eventStore.append({
    runId: job.runId,
    specId: context.specId,
    projectId: context.projectId,
    eventType: "job.dead_lettered",
    payload: {
      jobId: job.id,
      taskKind: job.taskKind,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      failureKind: "lease_expired",
      message: "retry budget exhausted after lease expiry"
    }
  });
}

async function loadRunLineage(pool: pg.Pool, runId: string): Promise<{ specId: string; projectId: string } | undefined> {
  const result = await pool.query("SELECT spec_id, project_id FROM runs WHERE run_id = $1", [runId]);
  const row = result.rows[0] as { spec_id?: unknown; project_id?: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return { specId: String(row.spec_id ?? ""), projectId: String(row.project_id ?? "") };
}

export interface JobReaperOptions {
  /** How often to run a reaper pass. */
  intervalMs?: number;
  /** Test seam: abortable sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired after each pass. */
  onPass?: (result: ReapJobsResult) => void;
}

const DEFAULT_REAP_INTERVAL_MS = 30_000;

/**
 * Background loop that runs {@link reapExpiredJobs} on an interval until
 * {@link JobReaper.stop} is called. Mirrors the RunWorker drain contract.
 */
export class JobReaper {
  private draining = false;
  private started = false;
  private loop: Promise<void> | undefined;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onPass: (result: ReapJobsResult) => void;

  constructor(
    private readonly deps: { pool: pg.Pool; jobQueue: JobQueue; eventStore?: EventStore },
    options: JobReaperOptions = {}
  ) {
    this.intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.onPass = options.onPass ?? defaultOnPass;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.draining = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.draining = true;
    await this.loop;
    this.loop = undefined;
    this.started = false;
  }

  private async run(): Promise<void> {
    while (!this.draining) {
      try {
        this.onPass(await reapExpiredJobs(this.deps));
      } catch (error) {
        console.warn(`[job-reaper] pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.draining) {
        return;
      }
      await this.sleep(this.intervalMs);
    }
  }
}

function defaultOnPass(result: ReapJobsResult): void {
  if (result.requeued > 0 || result.deadLettered > 0) {
    console.log(`[job-reaper] requeued=${result.requeued} dead_lettered=${result.deadLettered}`);
  }
}
