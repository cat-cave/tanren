import type { RunnerLifecycle, RunnerReclaimReason, StuckRunner } from "./runnerLifecycle.js";
import { createLogger } from "./logger.js";

const log = createLogger("allocator-sweeper");

/** A failure to RECORD the `runner.swept` audit; surfaces to {@link SweepSummary.recordErrors}. */
export interface SweepRecordError {
  runnerId: string;
  reason: RunnerReclaimReason;
  error: unknown;
}

/**
 * One sweep's outcome: the runners reclaimed (with their stuck-reason) + a per-reason
 * count + any audit-record failures. Loud-not-silent: a reclaim whose `runner.swept`
 * audit failed to write is COUNTED in `recordErrors`, never swallowed.
 */
export interface SweepSummary {
  reclaimed: StuckRunner[];
  /** Reclaim count per stuck-reason (zero entries omitted). */
  countsByReason: Partial<Record<RunnerReclaimReason, number>>;
  /** Reclaims whose durable `runner.swept` audit write threw (logged + counted, never silent). */
  recordErrors: SweepRecordError[];
}

export interface SweeperOptions {
  lifecycle: RunnerLifecycle;
  /**
   * Append the durable `runner.swept` audit for a reclaim (org-scoped). Injected
   * (the live impl is `PgRunnerStore.recordSwept`) so the sweeper unit-tests with
   * an in-memory recorder. A throw here is caught + counted in `recordErrors`.
   */
  recordSwept: (audit: {
    runnerId: string;
    runId: string | null;
    projectId: string | null;
    orgId: string;
    reason: RunnerReclaimReason;
  }) => Promise<void>;
  /** Maximum wall-clock hours before a runner is past its TTL ceiling (the apex leak guard). */
  maxRunHours: number;
  /** Grace window (ms) before a run-LESS (never-claimed) allocation is reclaimed as wedged. */
  unclaimedGraceMs: number;
  /** How often the sweeper polls. Default 60_000ms. */
  intervalMs?: number;
}

/**
 * RUNNER SWEEPER — the periodic reconciler that reclaims STUCK/LEAKED runners the
 * normal release path missed. Layer 2 of the runner-leak defense (the per-run
 * `release()` in the run's `finally` is layer 1; this is the safety net for when
 * that path never runs — a crashed run, a past-TTL runner, a wedged allocation).
 *
 * On each tick it asks the lifecycle for every runner in a genuine STUCK state
 * (owning run terminal but unreleased · past the run-hours TTL ceiling · run-less
 * allocation past the grace window), releases each through the SINGLE atomic claim
 * (so a healthy in-flight runner is never touched and a /release race tears down
 * once), and for each winning reclaim writes the durable `runner.swept` audit +
 * a structured log + a per-reason count. A reclaim's audit-write failure is LOUD
 * (logged + counted in `recordErrors`), never silent.
 *
 * Idempotent: a second tick over the same DB state reclaims nothing new. The
 * timer is `unref()`'d so it never keeps the process alive on its own.
 *
 * H10 lifecycle: `stop()` is async — it clears the timer first (so no new tick
 * starts) then AWAITS any in-flight tick, so worker teardown never races a live
 * sweep (a release/DB op outliving the pool close).
 */
export class RunnerSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking = false;
  // The in-flight tick's promise, tracked so `stop()` can AWAIT it.
  private inFlightTick: Promise<unknown> | undefined;
  private readonly lifecycle: RunnerLifecycle;
  private readonly recordSwept: SweeperOptions["recordSwept"];
  private readonly maxRunHours: number;
  private readonly unclaimedGraceMs: number;
  private readonly intervalMs: number;

  constructor(options: SweeperOptions) {
    this.lifecycle = options.lifecycle;
    this.recordSwept = options.recordSwept;
    this.maxRunHours = options.maxRunHours;
    this.unclaimedGraceMs = options.unclaimedGraceMs;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Stop the loop and AWAIT any in-flight tick so teardown never races a live
   * sweep. Clears the timer first (no new tick starts), then drains the current
   * one. Idempotent. (H10 pattern — mirrors RunWorkspaceReaper.stop.)
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlightTick?.catch(() => {});
  }

  /**
   * Run one reconciliation pass. Returns its summary (tests assert on it). A
   * concurrent tick or a stopped sweeper is a clean no-op (empty summary).
   */
  async tick(): Promise<SweepSummary> {
    if (this.ticking || this.stopped) {
      return emptySummary();
    }
    this.ticking = true;
    const settled = this.runTick();
    this.inFlightTick = settled;
    try {
      return await settled;
    } finally {
      this.ticking = false;
      if (this.inFlightTick === settled) {
        this.inFlightTick = undefined;
      }
    }
  }

  /** The actual sweep body, separated so `tick()` can track its in-flight promise. */
  private async runTick(): Promise<SweepSummary> {
    // A failure to LIST the stuck set is logged, never thrown — the next tick
    // retries (one bad poll never stops the loop).
    let reclaimed: StuckRunner[];
    try {
      reclaimed = await this.lifecycle.sweepStuck(this.maxRunHours, this.unclaimedGraceMs);
    } catch (error) {
      log.error("runner sweep failed (will retry next tick)", {}, error);
      return emptySummary();
    }

    const countsByReason: Partial<Record<RunnerReclaimReason, number>> = {};
    const recordErrors: SweepRecordError[] = [];
    for (const stuck of reclaimed) {
      const { record, reason } = stuck;
      countsByReason[reason] = (countsByReason[reason] ?? 0) + 1;
      log.warn("reclaimed stuck runner", {
        runnerId: record.runnerId,
        runId: record.runId ?? undefined,
        reason,
      });
      // LOUD-not-silent: the durable audit write is per-reclaim. A throw here does
      // NOT lose the reclaim (the runner is already released) but MUST be surfaced —
      // log it and count it in recordErrors, never swallow.
      try {
        await this.recordSwept({
          runnerId: record.runnerId,
          runId: record.runId,
          projectId: record.projectId,
          orgId: record.orgId,
          reason,
        });
      } catch (error) {
        log.error("failed to record runner.swept audit", { runnerId: record.runnerId, reason }, error);
        recordErrors.push({ runnerId: record.runnerId, reason, error });
      }
    }

    if (reclaimed.length > 0) {
      log.info("runner sweep reclaimed stuck runner(s)", {
        total: reclaimed.length,
        countsByReason,
        recordErrors: recordErrors.length,
      });
    }
    return { reclaimed, countsByReason, recordErrors };
  }
}

function emptySummary(): SweepSummary {
  return { reclaimed: [], countsByReason: {}, recordErrors: [] };
}
