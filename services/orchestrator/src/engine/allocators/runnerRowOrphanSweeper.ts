// RUNNER-ROW ORPHAN SWEEPER (task #9) — the orchestrator-side reconciler for
// `runners` rows the in-memory release path missed.
//
// THE LEAK SHAPE. The `static-runner` and `manual-ssh` allocators hold their
// runner-id → host bookkeeping in PROCESS-LOCAL memory (the leases / busy /
// resources Maps on each allocator instance). The `runners` table row is the
// DURABLE record of the lease — `release()` flips `status='released'` +
// `released_at=now()`. If the orchestrator CRASHES (or restarts mid-run, or the
// run's `finally` is bypassed by an `uncaughtException` the resilience net
// caught), the in-memory map vanishes but the `runners` row stays LIVE
// (`released_at IS NULL`) forever — visible to capacity bookkeeping + the merge
// `freshRunnerGate` as if the long-lived host were still leased, even though
// nothing is running on it.
//
// THE EPHEMERAL KINDS DON'T NEED THIS SWEEPER. A cloud allocator
// (Hetzner/DO/AWS/GCP/Kubernetes) and the `sidecar` allocator destroy the
// runner's underlying resource (droplet, container, pod) on release, so a
// stuck-`runners` row maps to a resource that was destroyed by the per-run
// allocate→try→finally inside the executor; for those, the orchestrator-side
// row is best-effort and the sidecar service has its OWN `RunnerSweeper` for
// the docker side. ONLY the long-lived (static, manual-ssh) paths have no
// external teardown and no other sweeper, so they accumulate orphan rows under
// crash-restart unless this loop reconciles them.
//
// SIGN-OF-LIFE OVER WALL-CLOCK (doctrine, `timeout-eradication.md` §1). The
// sweeper releases a row ONLY when its owning run is in a HARD-TERMINAL state
// (`completed`/`failed`/`cancelled`) — the same set the run-workspace reaper
// reads as "safe to reap". `halted` is recoverable (it can transition back to
// `running`) so a `halted` run's runner row is preserved. A run that is still
// genuinely advancing is NEVER touched, no matter how long it has been
// running.
//
// NO WALL-CLOCK CAP, NO AGE FILTER. There is intentionally no "rows older than
// N hours" predicate: a long-lived run on a static host is still LIVE work, and
// an age cap would re-introduce exactly the wall-clock kill the eradication
// program eliminated. The owning-run terminal state is the SOLE release signal.
//
// SCOPE. Filtered to the `allocator IN ('static-runner', 'manual-ssh')` set
// (the long-lived paths). A future kind that holds long-lived hosts joins this
// allowlist; an ephemeral kind never does.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { createLogger } from "../observability/logger.js";

const log = createLogger("runner-row-orphan-sweeper");

/**
 * The set of allocator-kind strings (matching the `runners.allocator` column
 * value, NOT the env `TANREN_ALLOCATOR_KIND` enum) the orphan sweeper
 * reconciles. Long-lived external hosts (static + manual-ssh) only — cloud /
 * sidecar runners have their own teardown + sweeper paths and are
 * deliberately excluded.
 */
export const RUNNER_ROW_ORPHAN_SWEEPER_ALLOCATORS: ReadonlyArray<string> = ["static-runner", "manual-ssh"];

/** The set of run-status values the sweeper treats as HARD TERMINAL (releasable). */
export const RUNNER_ROW_ORPHAN_TERMINAL_RUN_STATUSES: ReadonlyArray<string> = ["completed", "failed", "cancelled"];

/**
 * One reclaimed row's diagnostic, surfaced by `tick()` so tests can assert on
 * which rows were released this pass. Non-secret — runner/run/org ids only.
 */
export interface ReclaimedOrphan {
  runnerId: string;
  /** Always non-null on the static/manual_ssh paths (those allocators always set run_id). */
  runId: string | null;
  /** The org the orphan belonged to (the row stays tenant-scoped even after release). */
  orgId: string | null;
  /** `static-runner` or `manual-ssh` (per the {@link RUNNER_ROW_ORPHAN_SWEEPER_ALLOCATORS} allowlist). */
  allocator: string;
}

/** One sweep tick's outcome. Empty arrays + zero counts are a clean idempotent pass. */
export interface OrphanSweepSummary {
  reclaimed: ReclaimedOrphan[];
  /** Count by `allocator` (zero entries omitted) — observability surface for ops. */
  countsByAllocator: Record<string, number>;
}

export interface RunnerRowOrphanSweeperOptions {
  pool: pg.Pool;
  /** How often the sweeper polls. Defaults to 60_000 ms (one tick / minute). */
  intervalMs?: number;
}

interface ReclaimedRow {
  runner_id: string;
  run_id: string | null;
  org_id: string | null;
  allocator: string;
}

/**
 * The recurring orchestrator-side `runners`-row reconciler for long-lived
 * allocator kinds (static, manual-ssh). Releases rows whose owning run reached
 * a hard-terminal state but whose in-memory `release()` never ran (the
 * orchestrator-crash-mid-run shape).
 *
 * SHAPE — mirrors `RunWorkspaceReaper` + the allocator-sidecar `RunnerSweeper`:
 * `start()`/`stop()`/`tick()`, an `unref()`'d timer, per-tick error tolerance
 * (one bad poll never stops the loop), `stop()` AWAITS the in-flight tick so
 * teardown never races a live sweep.
 *
 * SYSTEM-SCOPE READ + WRITE. The sweep is cross-tenant by design (one sweeper
 * across all orgs, same as the run-workspace reaper + the sidecar sweeper), so
 * it runs the UPDATE under `runWithSystemScope` (BYPASSRLS). The released row
 * carries its original `org_id` unchanged — the row stays tenant-attributable
 * for downstream audits.
 *
 * IDEMPOTENT. A second tick over the same DB state reclaims nothing new (the
 * predicate matches only `released_at IS NULL` rows).
 */
export class RunnerRowOrphanSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking = false;
  /** The in-flight tick's promise, tracked so `stop()` can AWAIT it. */
  private inFlightTick: Promise<unknown> | undefined;
  private readonly pool: pg.Pool;
  private readonly intervalMs: number;

  constructor(options: RunnerRowOrphanSweeperOptions) {
    this.pool = options.pool;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // Same boot discipline as RunWorkspaceReaper: no immediate tick at boot
    // (an immediate sweep would race the very first run's allocate). First
    // tick fires after one interval; the timer is `unref()`'d so the sweeper
    // never holds the process alive on its own.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Stop the loop and AWAIT any in-flight tick so teardown never races a live
   * sweep. Clears the timer first (no new tick starts), then drains the current
   * one. Idempotent. Mirrors `RunWorkspaceReaper.stop` + the sidecar
   * `RunnerSweeper.stop` H10 pattern.
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
   * Run one reconciliation pass. Returns the summary (tests assert on it). A
   * concurrent tick or a stopped sweeper is a clean no-op (empty summary).
   */
  async tick(): Promise<OrphanSweepSummary> {
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
  private async runTick(): Promise<OrphanSweepSummary> {
    let reclaimed: ReclaimedRow[];
    try {
      reclaimed = await this.runReclaimSql();
    } catch (error) {
      // A failure to reclaim is logged and the next tick retries — one bad
      // poll never stops the loop (same shape as the sidecar sweeper's
      // list-failure tolerance).
      log.error("orphan sweep failed (will retry next tick)", {}, error);
      return emptySummary();
    }

    const countsByAllocator: Record<string, number> = {};
    for (const row of reclaimed) {
      countsByAllocator[row.allocator] = (countsByAllocator[row.allocator] ?? 0) + 1;
      log.warn("reclaimed orphan runner row (owning run hard-terminal; in-memory release never ran)", {
        runnerId: row.runner_id,
        runId: row.run_id ?? undefined,
        allocator: row.allocator,
      });
    }
    if (reclaimed.length > 0) {
      log.info("orphan sweep reclaimed runner row(s)", {
        total: reclaimed.length,
        countsByAllocator,
      });
    }
    return {
      reclaimed: reclaimed.map((row) => ({
        runnerId: row.runner_id,
        runId: row.run_id,
        orgId: row.org_id,
        allocator: row.allocator,
      })),
      countsByAllocator,
    };
  }

  /**
   * The single atomic reclaim statement. `UPDATE … FROM runs` joins the
   * orphan's owning run + flips the row to `status='abandoned',
   * released_at=now()` ONLY when the run is hard-terminal AND the allocator is
   * on the long-lived allowlist AND the row is still LIVE. `RETURNING` carries
   * the reclaimed rows back so the tick body can emit per-row diagnostics +
   * counts in ONE round-trip (no select-then-update split → no race window
   * where a concurrent release could land between the read + the write).
   */
  private async runReclaimSql(): Promise<ReclaimedRow[]> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<ReclaimedRow>(
        `UPDATE runners r
         SET status = 'abandoned', released_at = now()
         FROM runs run
         WHERE r.run_id = run.run_id
           AND r.released_at IS NULL
           AND r.allocator = ANY($1::text[])
           AND run.status = ANY($2::text[])
         RETURNING r.runner_id, r.run_id, r.org_id, r.allocator`,
        [RUNNER_ROW_ORPHAN_SWEEPER_ALLOCATORS, RUNNER_ROW_ORPHAN_TERMINAL_RUN_STATUSES],
      );
      return result.rows;
    });
  }
}

function emptySummary(): OrphanSweepSummary {
  return { reclaimed: [], countsByAllocator: {} };
}
