// queue lease recovery. A crashed or slow worker leaves its claimed job
// `running` with a lease it can no longer renew. The reaper periodically sweeps
// expired leases and requeues EVERY one — unbounded, no attempt-cap dead-letter
// (a lapsed lease is transient recovery, NOT a strike; the doctrine forbids a
// fixed attempt cap). Each requeue surfaces a LOUD `job.lease_expired` infra
// signal carrying the climbing re-claim count as evidence: a worker that keeps
// crashing on the same job is an infra problem to surface, never a job silently
// dropped on a count.
//
// This file OWNS the recovery side of the queue (the reaper loop + the
// lease-expiry event emission); the worker heartbeat that keeps a live job's
// lease fresh lives alongside the executor. observability stays OUT of here.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import { scalarText, scalarTextOr } from "../data/scalarText.js";
import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import type { JobQueue, ReapedJob } from "../contracts/jobQueue.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("job-reaper");

export interface ReapJobsDeps {
  pool: pg.Pool;
  jobQueue: JobQueue;
  eventStore?: EventStore;
  now?: Date;
}

export interface ReapJobsResult {
  requeued: number;
  // LOUD-over-swallowed (r6 §1): the lease-expiry recovery side-effect — the
  // operator-visible `job.lease_expired` infra signal — is best-effort, but a
  // FAILURE to write it is the exact condition the reaper exists to surface, so it
  // is logged (structured) AND counted here. A non-zero count on a pass means a
  // job was requeued but its operator signal (event) did not land.
  eventWriteFailed: number;
  jobs: ReapedJob[];
}

/**
 * Run one reaper pass: requeue EVERY `running` job whose lease has lapsed
 * (unbounded — no attempt-cap dead-letter). Emits a LOUD `job.lease_expired`
 * infra signal for each requeued job that is bound to a run, carrying the
 * climbing re-claim count as evidence. The event is best-effort but LOUD: a
 * failure to write it is logged (structured) and counted on the result
 * (`eventWriteFailed`) — never silently swallowed, since a worker that keeps
 * crashing is precisely the infra problem the reaper exists to surface.
 */
export async function reapExpiredJobs(deps: ReapJobsDeps): Promise<ReapJobsResult> {
  const reaped = await deps.jobQueue.reapExpiredLeases(deps.now === undefined ? undefined : { now: deps.now });
  // RLS R3a-worker: the default event store is constructed over an
  // `orgScopingPool`, so when the lease-expiry append runs under a reaped run's
  // per-job org-id (set below), its `events` INSERT opens a short org-scoped txn;
  // with no org-id (system / null-org job) it falls back to the pool (inert). An
  // injected event store (tests) is used verbatim.
  const eventStore = deps.eventStore ?? new PgEventStore(orgScopingPool(deps.pool));
  let requeued = 0;
  let eventWriteFailed = 0;
  for (const job of reaped) {
    requeued += 1;
    const failed = await emitLeaseExpiredEvent(deps.pool, eventStore, job);
    eventWriteFailed += failed ? 1 : 0;
  }
  return { requeued, eventWriteFailed, jobs: reaped };
}

/**
 * Emit the LOUD `job.lease_expired` infra signal for a requeued job. The job is
 * NOT terminal — it stays in_flight and keeps its DAG slot (the work continues),
 * so there is no spec park here (the work was not dropped). Returns true if the
 * event write failed (LOUD: logged + counted), false otherwise.
 */
async function emitLeaseExpiredEvent(pool: pg.Pool, eventStore: EventStore, job: ReapedJob): Promise<boolean> {
  if (job.runId === undefined) {
    return false;
  }
  const context = await loadRunLineage(pool, job.runId);
  if (context === undefined) {
    return false;
  }
  const append = (): Promise<void> =>
    eventStore.append({
      runId: job.runId!,
      specId: context.specId,
      projectId: context.projectId,
      eventType: "job.lease_expired",
      payload: {
        jobId: job.id,
        taskKind: job.taskKind,
        // DIAGNOSTIC evidence: how many times this job has been re-claimed. A
        // climbing count on the same job = a worker repeatedly crashing on it
        // (an infra problem to triage), NOT a give-up budget.
        attempts: job.attempts,
        failureKind: "lease_expired",
        message: "lease expired (worker crashed or stalled); job requeued for recovery",
      },
    });
  // RLS R3a-worker: scope the lease-expiry event to the reaped run's org via the
  // per-job org-id (the default PgEventStore then opens a short org-scoped txn
  // for the INSERT). A system / null-org job (org_id NULL) appends on the pool —
  // inert. A failed append is LOUD (logged + counted, r6 §1): losing this event
  // silently hides a crashing worker from the operator.
  try {
    await (context.orgId === null ? append() : runWithJobOrgId(context.orgId, append));
    return false;
  } catch (error) {
    log.error(
      "lease-expired event write failed (operator signal lost)",
      {
        jobId: job.id,
        runId: job.runId,
        specId: context.specId,
        projectId: context.projectId,
        orgId: context.orgId ?? undefined,
        reason: "event_write_failed",
      },
      error,
    );
    return true;
  }
}

async function loadRunLineage(
  pool: pg.Pool,
  runId: string,
): Promise<{ specId: string; projectId: string; orgId: string | null } | undefined> {
  // The reaper sweeps lapsed leases across ALL orgs in one pass, so resolving a
  // reaped run's lineage (incl. its org_id, to scope the lease-expiry event) is a
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
    specId: scalarTextOr(row.spec_id, ""),
    projectId: scalarTextOr(row.project_id, ""),
    orgId: row.org_id === null || row.org_id === undefined ? null : scalarText(row.org_id),
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
        log.warn("pass failed", {}, error);
      }
      if (this.draining) {
        return;
      }
      await this.sleep(this.intervalMs);
    }
  }
}

function defaultOnPass(result: ReapJobsResult): void {
  if (result.requeued > 0) {
    log.info("reaper pass", {
      requeued: result.requeued,
      eventWriteFailed: result.eventWriteFailed,
    });
  }
}
