// the background run worker loop. Runs in-process alongside the HTTP
// server (gated behind TANREN_RUN_WORKER=1, default OFF). Maintains up to
// `concurrency` in-flight `plan` jobs; each slot loops claim→execute until the
// queue is empty, then idles until either a job-enqueued NOTIFY wakes it or the
// safety-net backstop interval elapses.
//
// LISTEN/NOTIFY (replaces the old fixed 1s poll): each enqueue emits a NOTIFY on
// the `tanren_job_queue` channel; the worker LISTENs on it and an idle slot
// wakes the instant a job lands, so the poll interval is no longer the primary
// latency driver. The `pollIntervalMs` is now a long (default 20s) SAFETY-NET
// backstop, NOT a fallback-masking-misconfig: it only matters if a NOTIFY is
// missed (e.g. the LISTEN connection dropped mid-reconnect), and at worst adds
// backstop-bounded latency to an otherwise event-driven claim — never a wedge.
//
// Lifecycle: `start()` subscribes the listener + launches the slots; `stop()`
// sets the draining flag so slots stop claiming new work, then awaits all
// in-flight executions, releases any idle waiters, and unsubscribes. SIGTERM/
// SIGINT are wired by `installSignalHandlers` (called from main.ts) to drain
// gracefully before exit.

import { JOB_QUEUE_CHANNEL, type PgNotifyListener } from "@tanren/db";
import { executeNextPlanJob, type ExecuteJobResult, type RunExecutorDeps } from "./runExecutor.js";

export interface RunWorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  // Test seam: defaults to a real timer. Tests inject an immediate/abortable
  // sleep so the loop drains deterministically.
  sleep?: (ms: number) => Promise<void>;
  // Observability hook fired after each executed job (or idle poll). Defaults
  // to a one-line console log for completed/failed; tests capture results.
  onResult?: (result: ExecuteJobResult) => void;
  // LISTEN/NOTIFY wake source. When provided, the worker subscribes to the
  // `tanren_job_queue` channel and an idle slot wakes on enqueue instead of
  // waiting out the full backstop interval. Omitted in tests (and in the
  // legacy single-process path that has no dedicated LISTEN connection) — then
  // the worker degrades to pure backstop polling, behavior-identical to before.
  notifyListener?: PgNotifyListener;
}

const DEFAULT_CONCURRENCY = 2;
// Safety-net backstop, NOT the primary driver. With LISTEN/NOTIFY wired the
// worker wakes on enqueue; this only bounds latency if a NOTIFY is ever missed.
const DEFAULT_POLL_INTERVAL_MS = 20_000;

export class RunWorker {
  private draining = false;
  private started = false;
  private readonly slots: Promise<void>[] = [];
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onResult: (result: ExecuteJobResult) => void;
  private readonly notifyListener: PgNotifyListener | undefined;
  // Resolvers for slots currently parked in the idle wait. A job-enqueued
  // NOTIFY (or stop()) resolves them all so they re-attempt a claim at once.
  private readonly idleWaiters = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly deps: RunExecutorDeps,
    options: RunWorkerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.onResult = options.onResult ?? defaultOnResult;
    this.notifyListener = options.notifyListener;
  }

  /** Launch the worker slots. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.draining = false;
    // Subscribe BEFORE launching slots so an enqueue that races startup still
    // wakes us. Best-effort: a failed subscribe leaves the worker on the
    // backstop poll rather than killing startup.
    void this.subscribeWake();
    for (let slot = 0; slot < this.concurrency; slot += 1) {
      this.slots.push(this.runSlot());
    }
  }

  /** Stop claiming new work and await all in-flight executions. */
  async stop(): Promise<void> {
    this.draining = true;
    this.wakeIdleSlots();
    await Promise.all(this.slots);
    this.slots.length = 0;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** True once `stop()` has been requested (slots stop claiming). */
  get isDraining(): boolean {
    return this.draining;
  }

  private async subscribeWake(): Promise<void> {
    if (this.notifyListener === undefined) {
      return;
    }
    try {
      this.unsubscribe = await this.notifyListener.subscribe(JOB_QUEUE_CHANNEL, () => {
        this.wakeIdleSlots();
      });
    } catch {
      // No LISTEN connection: fall through to backstop polling. A genuinely
      // broken DB surfaces on the next claim attempt, not here.
    }
  }

  private wakeIdleSlots(): void {
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  // Park an idle slot until a NOTIFY wakes it, the backstop interval elapses, or
  // stop() releases it — whichever comes first.
  private async idleWait(): Promise<void> {
    const { promise, resolve } = deferred();
    this.idleWaiters.add(resolve);
    try {
      await Promise.race([this.sleep(this.pollIntervalMs), promise]);
    } finally {
      this.idleWaiters.delete(resolve);
    }
  }

  private async runSlot(): Promise<void> {
    while (!this.draining) {
      let result: ExecuteJobResult;
      try {
        result = await executeNextPlanJob(this.deps);
      } catch (error) {
        // executeNextPlanJob is defensive (it catches workflow throws), so a
        // throw here is an infrastructure fault (e.g. DB down on claim). Log
        // and back off rather than killing the slot.
        result = {
          kind: "failed",
          jobId: "<unclaimed>",
          failure: {
            kind: "worker_infra_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      this.onResult(result);
      if (result.kind === "idle") {
        if (this.draining) {
          return;
        }
        await this.idleWait();
      }
    }
  }
}

// A resolvable promise (the ES2024 `Promise.withResolvers` shape, hand-rolled
// since the repo targets ES2022). Used to park an idle slot until woken.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  // `unset` is an unreachable initializer (TS requires a definite assignment);
  // the Promise executor runs synchronously and overwrites it before `resolve`
  // is ever exposed. Not a no-op policy — just the withResolvers placeholder.
  let resolve: () => void = unset;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function unset(): void {}

function defaultOnResult(result: ExecuteJobResult): void {
  if (result.kind === "completed") {
    console.log(`[run-worker] job ${result.jobId} completed run ${result.runId} (outcome=${result.outcome})`);
  } else if (result.kind === "failed") {
    console.warn(`[run-worker] job ${result.jobId} failed (${result.failure.kind}): ${result.failure.message}`);
  }
}
