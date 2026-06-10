// P1d — put the scheduled-audit scheduler ON A LOOP (autonomy-engine.md §1d:
// "The audit scheduler currently isn't on a loop — put it on one."). The audit
// scheduler (`runAuditJob`) was previously invoked only by the manual
// `POST …/audits/:id/run` route. This wraps it in a recurring per-job loop: on a
// tick, every enabled job whose cadence window has elapsed since its `lastRun`
// runs its read-only pass and auto-routes findings into the candidate inbox —
// exactly the same hand-off, now driven by the clock instead of an operator.
//
// Like the intake poller this is a long-lived per-process loop the worker boot
// starts; it is cross-org (system-scoped) and tolerant of a per-job failure.

import type pg from "pg";
import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import { orgScopingPool } from "../../data/orgScopedDb.js";
import { AuditsStore } from "../../repositories/audits.js";
import { runAuditJob } from "./scheduler.js";
import type { AuditCadence, AuditJob, AuditPassRunner } from "./types.js";
import type { AutoRouteDeps, TriageAnswerer } from "../inbox/index.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("audit-scheduler");

// The cadence → minimum elapsed window before a job is due again. A job with no
// `lastRun` is always due (its first pass).
const CADENCE_MS: Record<AuditCadence, number> = {
  nightly: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  monthly: 30 * 24 * 60 * 60_000,
};

export interface AuditSchedulerLoopDeps {
  pool: pg.Pool;
  // The read-only pass runner (no-op default until an SSH-backed pass is wired —
  // the §8a "absence is honest" case; a clean pass records no findings).
  passRunner: AuditPassRunner;
  // Per-job triage answerer factory — a finding is triaged by the real provider
  // answerer (no §8a fallback). Consulted only when a pass produces a finding.
  answererFactory: (target: { orgId: string; projectId?: string }) => TriageAnswerer;
  // Autonomous DAG insert (autonomy-engine.md §1d): the auto-route deps that
  // commit an `auto_routed` finding's `routableSpec` into the DAG — so a
  // scheduled audit autonomously becomes a real spec. Carries the control-plane
  // `runStateWriter` (plane-split). Mirrors the intake poller.
  autoRoute: AutoRouteDeps;
  now?: () => number;
}

/** Whether a job is due to run now (cadence window elapsed since its last run). */
export function isAuditJobDue(job: AuditJob, now: number): boolean {
  if (!job.enabled) return false;
  if (job.lastRun === null) return true;
  const last = Date.parse(job.lastRun);
  if (Number.isNaN(last)) return true;
  return now - last >= CADENCE_MS[job.cadence];
}

/**
 * The recurring audit scheduler. `start()` ticks on an interval; each tick runs
 * every enabled, due job through `runAuditJob` (findings auto-route into the
 * inbox). Per-job last-run is the persisted `lastRun` column (durable across
 * restarts), so a tick after downtime catches up due jobs.
 */
export class AuditSchedulerLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: AuditSchedulerLoopDeps,
    private readonly tickIntervalMs: number = 60 * 60_000,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one pass over all due audit jobs. Returns the jobs run (tests assert). */
  async tick(): Promise<AuditJob[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      // A failure to LIST jobs (e.g. the DB not yet reachable at boot) is logged,
      // never thrown — the next tick retries.
      let jobs: AuditJob[];
      try {
        jobs = await this.listDueJobs();
      } catch (error) {
        log.error("failed to list audit jobs (will retry next tick)", {}, error);
        return [];
      }
      const ran: AuditJob[] = [];
      for (const job of jobs) {
        try {
          const result = await runWithJobOrgId(job.orgId, () =>
            runAuditJob(
              {
                pool: orgScopingPool(this.deps.pool),
                passRunner: this.deps.passRunner,
                answerer: this.deps.answererFactory({
                  orgId: job.orgId,
                  ...(job.projectId === null ? {} : { projectId: job.projectId }),
                }),
                autoRoute: this.deps.autoRoute,
              },
              job,
            ),
          );
          ran.push(result.job);
        } catch (error) {
          log.error("audit job failed", { jobId: job.id }, error);
        }
      }
      return ran;
    } finally {
      this.ticking = false;
    }
  }

  private async listDueJobs(): Promise<AuditJob[]> {
    const now = this.now();
    const orgIds = await runWithSystemScope(this.deps.pool, (client) => AuditsStore.listDistinctAuditJobOrgIds(client));
    const due: AuditJob[] = [];
    for (const orgId of orgIds) {
      const jobs = await runWithSystemScope(this.deps.pool, (client) => AuditsStore.listAuditJobs(client, orgId));
      for (const job of jobs) if (isAuditJobDue(job, now)) due.push(job);
    }
    return due;
  }
}
