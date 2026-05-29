// P3-0001: the background run worker loop. Runs in-process alongside the HTTP
// server (gated behind TANREN_RUN_WORKER=1, default OFF). Maintains up to
// `concurrency` in-flight `plan` jobs; each slot loops claim→execute until the
// queue is empty, then idles `pollIntervalMs` before polling again.
//
// Lifecycle: `start()` launches the slots; `stop()` sets the draining flag so
// slots stop claiming new work, then awaits all in-flight executions and
// resolves. SIGTERM/SIGINT are wired by `installSignalHandlers` (called from
// main.ts) to drain gracefully before exit.

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
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class RunWorker {
  private draining = false;
  private started = false;
  private readonly slots: Promise<void>[] = [];
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onResult: (result: ExecuteJobResult) => void;

  constructor(
    private readonly deps: RunExecutorDeps,
    options: RunWorkerOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.onResult = options.onResult ?? defaultOnResult;
  }

  /** Launch the worker slots. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.draining = false;
    for (let slot = 0; slot < this.concurrency; slot += 1) {
      this.slots.push(this.runSlot());
    }
  }

  /** Stop claiming new work and await all in-flight executions. */
  async stop(): Promise<void> {
    this.draining = true;
    await Promise.all(this.slots);
    this.slots.length = 0;
    this.started = false;
  }

  /** True once `stop()` has been requested (slots stop claiming). */
  get isDraining(): boolean {
    return this.draining;
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
        await this.sleep(this.pollIntervalMs);
      }
    }
  }
}

function defaultOnResult(result: ExecuteJobResult): void {
  if (result.kind === "completed") {
    console.log(`[run-worker] job ${result.jobId} completed run ${result.runId} (outcome=${result.outcome})`);
  } else if (result.kind === "failed") {
    console.warn(`[run-worker] job ${result.jobId} failed (${result.failure.kind}): ${result.failure.message}`);
  }
}
