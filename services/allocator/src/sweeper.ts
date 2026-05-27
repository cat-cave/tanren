import type { RunnerLifecycle, RunnerRecord } from "./runnerLifecycle.js";

export interface SweeperOptions {
  lifecycle: RunnerLifecycle;
  /** Maximum age of an active runner row before the sweeper reclaims it. */
  maxRunHours: number;
  /** How often the sweeper polls. */
  intervalMs?: number;
  /** Hook for surfacing reclaim events; defaults to console.log. */
  onReclaim?: (record: RunnerRecord) => void | Promise<void>;
}

export class AbandonedRunSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lifecycle: RunnerLifecycle;
  private readonly maxRunHours: number;
  private readonly intervalMs: number;
  private readonly onReclaim: (record: RunnerRecord) => void | Promise<void>;

  constructor(options: SweeperOptions) {
    this.lifecycle = options.lifecycle;
    this.maxRunHours = options.maxRunHours;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.onReclaim =
      options.onReclaim ??
      ((record) => {
        console.log(`[allocator] reclaimed abandoned runner ${record.runnerId} for run ${record.runId}`);
      });
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error(`[allocator] sweeper error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<RunnerRecord[]> {
    const reclaimed = await this.lifecycle.sweepAbandoned(this.maxRunHours * 3_600_000);
    for (const record of reclaimed) {
      await this.onReclaim(record);
    }
    return reclaimed;
  }
}
