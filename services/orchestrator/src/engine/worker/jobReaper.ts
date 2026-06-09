// queue lease recovery. A crashed worker leaves its claimed job
// `running` with a lease it can no longer renew. The reaper periodically sweeps
// expired leases: jobs with retry budget remaining go back to `queued` (so a
// healthy worker re-claims them), and jobs that have exhausted their bounded
// re-claim budget are moved to the terminal `dead_letter` state and surfaced
// via a `job.dead_lettered` lifecycle event for operator triage.
//
// This file OWNS the recovery side of the queue (the reaper loop + dead-letter
// event emission); the worker heartbeat that keeps a live job's lease fresh
// lives alongside the executor. observability stays OUT of here.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
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
  // RLS R3a-worker: the default event store is constructed over an
  // `orgScopingPool`, so when the dead-letter append runs under a reaped run's
  // per-job org-id (set below), its `events` INSERT opens a short org-scoped txn;
  // with no org-id (legacy/unscoped run) it falls back to the pool (inert). An
  // injected event store (tests) is used verbatim.
  const eventStore = deps.eventStore ?? new PgEventStore(orgScopingPool(deps.pool));
  let requeued = 0;
  let deadLettered = 0;
  for (const job of reaped) {
    if (job.outcome === "requeued") {
      requeued += 1;
      continue;
    }
    deadLettered += 1;
    await emitDeadLetterEvent(deps.pool, eventStore, job).catch(() => {});
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
  // DEAD-LETTER FINALIZER (audit §3.13c): a dead-lettered job is TERMINAL — its run is
  // never re-claimed. Without finalizing the spec it stays `in_flight` FOREVER,
  // occupying its DAG slot (the walker counts it in-flight and never re-enqueues it) and
  // blocking every dependent permanently. Park the spec at `needs_attention` — the SAME
  // terminal escalation a genuine merge conflict uses (coordinatorEscalate.ts): it FREES
  // the slot (the rest of the DAG advances), blocks ONLY its dependents, and is
  // operator-visible. The `job.dead_lettered` event below names the cause. Best-effort,
  // org-scoped, ATOMIC-guarded (an already-terminal spec is left untouched) — a park
  // failure must never mask the dead-letter event.
  if (context.specId !== "" && context.orgId !== null) {
    await parkDeadLetteredSpec(pool, context.orgId, context.specId).catch(() => {});
  }
  const append = (): Promise<void> =>
    eventStore.append({
      runId: job.runId!,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "job.dead_lettered",
      payload: {
        jobId: job.id,
        taskKind: job.taskKind,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        failureKind: "lease_expired",
        message: "retry budget exhausted after lease expiry",
      },
    });
  // RLS R3a-worker: scope the dead-letter event to the reaped run's org via the
  // per-job org-id (the default PgEventStore then opens a short org-scoped txn
  // for the INSERT). A legacy/unscoped run (org_id NULL) appends on the pool —
  // inert, identical to before this cohort.
  await (context.orgId === null ? append() : runWithJobOrgId(context.orgId, append));
}

/**
 * Park the dead-lettered job's spec at the terminal `needs_attention` status under the
 * run's org scope (audit §3.13c). ATOMIC-guarded: the `status NOT IN (...)` clause means
 * an already-terminal spec (merged / done / halted / cancelled / already needs_attention)
 * is never moved, so a concurrent settle never un-merges or double-parks. Mirrors
 * `PgSpecEscalator.parkSpec` (the merge-queue conflict escalation) — ONE escalation
 * policy across both surfaces. The flip FREES the spec's DAG slot.
 */
async function parkDeadLetteredSpec(pool: pg.Pool, orgId: string, specId: string): Promise<void> {
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(
      `UPDATE specs SET status = 'needs_attention'
         WHERE spec_id = $1 AND status NOT IN ('merged', 'done', 'halted', 'cancelled', 'needs_attention')`,
      [specId],
    );
  });
}

async function loadRunLineage(
  pool: pg.Pool,
  runId: string,
): Promise<{ specId: string; projectId: string; orgId: string | null } | undefined> {
  // The reaper sweeps lapsed leases across ALL orgs in one pass, so resolving a
  // reaped run's lineage (incl. its org_id, to scope the dead-letter event) is a
  // legitimately cross-org BOOTSTRAP read — it runs under the worker's system
  // context (no org GUC), mirroring the job-queue claim. (R3b fork: under
  // enforced policies this read needs a bypass-role / policy carve-out — the
  // locked-decision item in the RLS plan; see R-WAVES.)
  const result = await runWithSystemScope(pool, (client) =>
    client.query("SELECT spec_id, project_id, org_id FROM runs WHERE run_id = $1", [runId]),
  );
  const row = result.rows[0] as { spec_id?: unknown; project_id?: unknown; org_id?: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    specId: String(row.spec_id ?? ""),
    projectId: String(row.project_id ?? ""),
    orgId: row.org_id === null || row.org_id === undefined ? null : String(row.org_id),
  };
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
    options: JobReaperOptions = {},
  ) {
    this.intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
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
