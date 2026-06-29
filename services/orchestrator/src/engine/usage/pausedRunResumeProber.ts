// task #82 — the WINDOW-PAUSE AUTO-RESUME prober. A background loop that finds
// runs in the NEW non-terminal `paused` status (a `window_exhausted` writer
// outcome / a `CodexUsageLimitError` answerer throw / a preflight pressure
// escalation flipped them there) and RESUMES them when their provider's usage
// window refreshes — sign-of-life, never a wall-clock deadline.
//
// THE DOCTRINE EXTENSION (CLAUDE.md timeout-eradication):
// "Kill on evidence of death, never on the passage of time." A provider whose
// window is currently exhausted is NOT dead — it is gated on a refresh signal
// that can land at any time (the natural reset at `resetsAt`, OR a free reset
// the provider awards earlier — free usage resets, new-model launches, billing
// changes). The prober is a PROBE on the refresh signal, NOT a timer toward a
// deadline. No "give up after N hours"; capacity always returns.
//
// THE RESUME SHAPE — "re-drive is the probe":
// The prober does NOT shell out to the provider's CLI itself (the orchestrator
// has no runner and the codexbar / usage probes are runner-side over SSH per
// the no-host-process-spawn rule). Instead it transitions the paused run to
// `halted` (outcome `window_paused`, the distinct recovery WHY preserved) and
// flips the spec from `in_flight` → `open` with `dag.spec.redriven` — the
// WALKER's standard re-drive seam. The re-driven run runs its existing
// `checkWindowPreflight` (subtaskAccounting) against the same usage probe the
// pause originally tripped: a CLEAN preflight ⇒ the writer runs, work
// resumes; a STILL-EXHAUSTED preflight ⇒ the new run flips right back to
// `paused` and the prober probes again on its next tick. The probe IS the
// next run's preflight; the cadence is the prober's tick interval.
//
// THE CADENCE — sign-of-life, not a deadline:
// `DEFAULT_PROBE_INTERVAL_MS` is HOW OFTEN to ask "did capacity return", not
// a deadline. A paused run is probed every tick FOREVER until capacity
// returns or the operator manually escalates it. The interval is a tunable
// (a test injects 50ms; production defaults to 60s — long enough that a busy
// stack does not spin allocators per minute, short enough that a freshly-
// reset window resumes within a minute of the reset). The `resetsAt` snapshot
// on `run.paused` is a FLOOR HINT, not a deadline: capacity can return
// earlier (free reset) and the prober still catches it on its next tick.
//
// PROVIDER-UNHEALTHY (a different beast):
// The prober's resume path is for the WINDOW-PRESSURE class (the writer ran,
// the provider acknowledged the call, the window is just spent). A DIFFERENT
// class is the provider's probe ITSELF being broken — auth revoked, account
// suspended, CLI binary missing — which surfaces as a preflight `usage.read_failed`
// with a structural failure reason. That class is handled by the subtask
// loop's preflight branch in {@link checkWindowPreflight}: a `failure.reason`
// of `nonzero_exit` / `ssh_failure` is LOUD and surfaces as `usage.read_failed`,
// which the standard finalize/convergence path classifies. This prober does
// NOT itself probe the provider — the next run's preflight is the only health
// signal in play. No "future extension can add a probe" seam is reserved here:
// the orchestrator owns ONE path today, and an orchestrator-side health probe
// (if it ever ships) lands as its own loop, not a paused-run terminal exit.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { applyResumePausedRunAtomic } from "../worker/runStateAtomicSql.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("paused-run-resume-prober");

/** The probe-tick interval default — sign-of-life cadence, NOT a deadline.
 *
 * 60s balances responsiveness (a refreshed window resumes within a minute)
 * against probe spam. A test injects a small value (the conformance pattern
 * `subscriber.ts` uses for `reWalkIntervalMs`). The interval is NOT a
 * timeout — paused runs stay paused FOREVER until capacity returns. */
export const DEFAULT_PROBE_INTERVAL_MS = 60_000;

/** One row the prober reads off the paused-runs query. */
interface PausedRunRow {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
  pausedAt: Date;
}

export interface PausedRunResumeProberDeps {
  pool: pg.Pool;
  /** Plane-split (autonomy loops): when wired, the resume's atomic seam routes
   * through the control plane (the de-privileged data plane can no longer
   * write `runs`/`specs`/`events` directly — migrations 0031/0035). Absent ⇒
   * direct in-process org-scoped writes (the dev path). */
  runStateWriter?: RunStateWriter;
  /** Probe-tick cadence. Defaults to {@link DEFAULT_PROBE_INTERVAL_MS}. A test
   * injects a small value (no-deadline doctrine: this is HOW OFTEN to ask,
   * never a budget). */
  probeIntervalMs?: number;
  /** Injectable `setInterval`/`clearInterval` seam (the conformance pattern from
   * `dag/subscriber.ts`'s periodic backstop). A test injects a controllable
   * pair so the tick is deterministic. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** The running prober handle. `stop()` is idempotent. */
export interface PausedRunResumeProber {
  /** Run one probe tick synchronously (test seam). */
  probeOnce(): Promise<{ resumedRunIds: string[] }>;
  /** Tear down the periodic tick. Idempotent. */
  stop(): void;
}

/**
 * Build + start the prober. The tick runs immediately on start (so a paused
 * run hanging in a clean post-restart DB resumes quickly), then on every
 * subsequent interval. A tick failure is LOUD-but-non-fatal — the next tick
 * retries; a single transient DB hiccup never kills the loop.
 */
export function startPausedRunResumeProber(deps: PausedRunResumeProberDeps): PausedRunResumeProber {
  const probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let stopped = false;
  let inFlight: Promise<{ resumedRunIds: string[] }> | null = null;
  const tick = (): Promise<{ resumedRunIds: string[] }> => {
    if (stopped) return Promise.resolve({ resumedRunIds: [] });
    // Coalesce: if a tick is already in flight, every caller awaits its result.
    // The atomic-seam guards make a double-probe a no-op, but coalescing keeps
    // the run-by-run loop linear so a slow probe never N-multiplies allocator
    // pressure. Crucially, `probeOnce()` callers join the in-flight tick's
    // result rather than getting an empty resolution.
    if (inFlight !== null) return inFlight;
    const work = probeAndResume(deps).catch((error: unknown) => {
      log.error("paused-run probe tick failed (will retry on the next tick)", {}, error);
      return { resumedRunIds: [] as string[] };
    });
    inFlight = work;
    void work.finally(() => {
      if (inFlight === work) inFlight = null;
    });
    return work;
  };
  // Fire-and-forget initial tick so a restart resumes any pre-existing paused
  // runs without waiting `probeIntervalMs`.
  void tick();
  const timer = setIntervalFn(() => {
    void tick();
  }, probeIntervalMs);
  return {
    async probeOnce() {
      return await tick();
    },
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

/**
 * Discover every paused run + resume each one through the atomic seam. A
 * row's resume writes the `run.resumed` event (paired with the row finalize
 * to `halted`) and the spec flip to `open` + `dag.spec.redriven` (paired
 * with the spec UPDATE) — the walker's standard re-drive seam. The walker
 * picks up the now-`open` spec on its notification-driven re-walk and
 * enqueues a successor; that successor's `checkWindowPreflight` is the
 * actual capacity test.
 */
async function probeAndResume(deps: PausedRunResumeProberDeps): Promise<{ resumedRunIds: string[] }> {
  const rows = await loadPausedRuns(deps.pool);
  const resumedRunIds: string[] = [];
  for (const row of rows) {
    try {
      await resumeOne(deps, row);
      resumedRunIds.push(row.runId);
    } catch (error) {
      log.error(
        "failed to resume one paused run (will retry on the next tick)",
        { runId: row.runId, specId: row.specId, projectId: row.projectId },
        error,
      );
    }
  }
  return { resumedRunIds };
}

/** Read every paused run with its org / spec / project ids for the resume writes.
 *
 * System-scoped (cross-org) read — the prober is a platform loop, not a
 * tenant-bound caller. The actual writes per row open the OWNING run's org
 * scope (RLS-correct). */
async function loadPausedRuns(pool: pg.Pool): Promise<PausedRunRow[]> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{
      run_id: string;
      spec_id: string;
      project_id: string;
      org_id: string;
      ended_at: Date | null;
    }>(
      `SELECT r.run_id, r.spec_id, r.project_id, r.org_id, r.ended_at
         FROM runs r
        WHERE r.status = 'paused'`,
    );
    const rows: PausedRunRow[] = [];
    for (const row of result.rows) {
      if (row.spec_id === null || row.project_id === null || row.org_id === null) continue;
      rows.push({
        runId: row.run_id,
        specId: row.spec_id,
        projectId: row.project_id,
        orgId: row.org_id,
        pausedAt: row.ended_at ?? new Date(),
      });
    }
    return rows;
  });
}

/** Resume one paused run as ONE atomic unit (audit finding #3): the run
 * finalize (`paused → halted` + `run.resumed`) AND the spec flip
 * (`in_flight → open` + `dag.spec.redriven`) land or fail TOGETHER in a
 * single org-scoped transaction. Replaces the prior two-seam split that
 * could strand `runs.status=halted` + `specs.status=in_flight` on a crash
 * between them — the prober's `WHERE status='paused'` poll never re-matched
 * that row, and the walker won't redrive an `in_flight` spec, so the spec
 * was orphaned indefinitely. The walker re-walks the project on the
 * `run.resumed` notification and enqueues a successor run for the spec. */
async function resumeOne(deps: PausedRunResumeProberDeps, row: PausedRunRow): Promise<void> {
  const pausedDurationSeconds = Math.max(0, Math.floor((Date.now() - row.pausedAt.getTime()) / 1000));
  const resumedEvent = {
    runId: row.runId,
    specId: row.specId,
    projectId: row.projectId,
    eventType: "run.resumed" as const,
    payload: {
      provider: "agent",
      slot: "primary",
      usedPercent: 0,
      pausedDurationSeconds,
    },
  };
  const redrivenEvent = {
    runId: row.runId,
    specId: row.specId,
    projectId: row.projectId,
    eventType: "dag.spec.redriven" as const,
    payload: {
      specId: row.specId,
      runId: row.runId,
      // `usage_limit` is the canonical RunFailureCode the dag.spec.redriven
      // payload schema enumerates — used as a placeholder only because the
      // spec pair-schema requires SOME failure code for an `open` flip event.
      // The `source: "prober_resume"` discriminator below tells the
      // convergence history reader (`buildRedriveHistoryReader`) to FILTER
      // this row out entirely (audit finding #13): a prober resume is NOT a
      // structural re-drive and must not be folded into the fixed-point
      // signature (otherwise an `internal, usage_limit, internal` sequence
      // reads as "new state appeared" and masks a genuine stuck spec).
      failureCode: "usage_limit" as const,
      stage: "agent" as const,
      // Carried for payload-shape uniformity only — the reader filters this
      // row out via `source` before the streak is computed, so the counter
      // never advances on a window-pressure resume. Window pressure NEVER
      // escalates to `needs_attention`.
      consecutiveSameFailure: 0,
      backoffSeconds: 0,
      // Audit finding #13: discriminator that excludes prober resumes from
      // the structural-redrive convergence history (see
      // `buildRedriveHistoryReader` in `plannerRunRedrive.ts`).
      source: "prober_resume" as const,
    },
  };
  const finalize = {
    runId: row.runId,
    orgId: row.orgId,
    status: "halted" as const,
    outcome: "window_paused" as const,
    fromStatuses: ["paused"],
  };
  const spec = {
    specId: row.specId,
    orgId: row.orgId,
    status: "open" as const,
    notFromStatuses: ["merged", "needs_attention"],
  };
  // Plane-split: route through the control plane when wired, else in-process
  // atomic apply under the run's org scope. Either way, ONE transaction.
  if (deps.runStateWriter !== undefined) {
    await deps.runStateWriter.resumePausedRunAtomic({
      finalize,
      resumedEvent,
      spec,
      redrivenEvent,
    });
    return;
  }
  await runWithOrgScope(deps.pool, row.orgId, async (client) => {
    await applyResumePausedRunAtomic(client, {
      finalize,
      resumedEvent,
      spec,
      redrivenEvent,
    });
  });
}
