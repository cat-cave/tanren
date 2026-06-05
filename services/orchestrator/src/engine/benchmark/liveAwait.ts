// Live terminal-await seam (docs/roadmap/tanren-method-benchmark.md §4.2 item 2).
//
// This is the PRODUCTION injection for the BenchmarkRunner's `awaitTerminal`
// seam. The runner enqueues a trial's `plan` job and the worker executes it; this
// module waits for that run to reach a TERMINAL `runs.status` (completed/
// halted/failed/cancelled) and returns its snapshot — or undefined if the
// deadline passes without terminating.
//
// It REUSES the same Postgres LISTEN/NOTIFY run-activity channel the SSE source
// uses (`PgNotifyListener` over `tanren_run`, filtered to this run id) so it
// WAKES on the run's state changes rather than hot-polling. A long bounded
// safety-net re-check covers a missed notification (e.g. a LISTEN reconnect gap)
// — NOT a fresh 1s poller. The run-status read itself reuses `readRunStatus`
// (org-scoped, RLS) and the terminal predicate reuses `isTerminalStatus`.

import { RUN_ACTIVITY_CHANNEL, type PgNotifyListener } from "@tanren/db";
import type pg from "pg";
import { isTerminalStatus, readRunStatus, type RunStatusSnapshot } from "./runnerDb.js";

/** What the live await seam needs from the boot to wake on run activity. */
export interface LiveAwaitDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (the SAME one the SSE source uses). */
  notifyListener: PgNotifyListener;
  /** Safety-net re-check interval (ms) — a missed-NOTIFY backstop, NOT a hot poll. */
  safetyNetPollMs?: number;
  /** Max wall-clock to await one trial's terminal state (ms). */
  trialTimeoutMs?: number;
}

// A long backstop: with the NOTIFY wake wired this is NOT the primary latency
// driver — it only bounds latency if a notification is ever missed. Matches the
// SSE source's 20s safety-net cadence.
const DEFAULT_SAFETY_NET_POLL_MS = 20_000;
// 30m — a real trial is a full run (plan→write→check→audit→PR→CI→merge).
const DEFAULT_TRIAL_TIMEOUT_MS = 1_800_000;

/**
 * Build the production `awaitTerminal` seam injected into the BenchmarkRunner.
 * The returned fn subscribes to the run-activity channel (filtered to this run),
 * re-reads `runs.status` on each wake (and on the safety-net backstop), and
 * resolves with the terminal snapshot the first time the run is terminal — or
 * undefined when the deadline passes without a terminal status. The subscription
 * is always torn down (success, timeout, or throw).
 */
export function buildLiveAwaitTerminal(
  deps: LiveAwaitDeps,
): (input: { orgId: string; runId: string }) => Promise<RunStatusSnapshot | undefined> {
  const safetyNetPollMs = deps.safetyNetPollMs ?? DEFAULT_SAFETY_NET_POLL_MS;
  const timeoutMs = deps.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  return async ({ orgId, runId }) => {
    const deadline = Date.now() + timeoutMs;

    // The wake gate: a NOTIFY for THIS run resolves the parked waiter so the loop
    // re-reads immediately instead of waiting out the safety-net backstop. The
    // holder carries the current park's resolver: the NOTIFY handler fires it (so
    // a single subscription drives every iteration's wake) and the loop swaps the
    // resolver in/out per park — no per-iteration closure declared in the loop.
    const waker: WakeHolder = { resolve: undefined };
    const unsubscribe = await deps.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
      if (payload === runId) waker.resolve?.();
    });

    try {
      for (;;) {
        // Read FIRST (before parking) so a run already terminal at subscribe time
        // — or one that terminated between reads — resolves without a wake.
        const snapshot = await readRunStatus(deps.pool, orgId, runId);
        if (snapshot !== undefined && isTerminalStatus(snapshot.status)) return snapshot;
        if (Date.now() >= deadline) return snapshot;

        // Park until this run's NOTIFY wakes us OR the safety-net interval elapses
        // (whichever first), bounded by the overall deadline. The backstop is the
        // missed-notification net, not the primary driver.
        const waitMs = Math.min(safetyNetPollMs, Math.max(0, deadline - Date.now()));
        await waitForWake(waitMs, waker);
        waker.resolve = undefined;
      }
    } finally {
      unsubscribe();
    }
  };
}

/** Carries the current park's resolver so one NOTIFY subscription drives every iteration. */
interface WakeHolder {
  resolve: (() => void) | undefined;
}

/**
 * Park for up to `waitMs`, resolving early if the run's NOTIFY fires (the holder's
 * resolver is invoked). The timer is unref'd so a pending await never keeps the
 * process alive on its own.
 */
function waitForWake(waitMs: number, holder: WakeHolder): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, waitMs);
    if (typeof timer.unref === "function") timer.unref();
    holder.resolve = settle;
  });
}
