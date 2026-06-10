import type { RunnerLifecycle, RunnerRecord } from "./runnerLifecycle.js";
import { createLogger } from "./logger.js";

const log = createLogger("allocator-sweeper");

export interface SweeperOptions {
  lifecycle: RunnerLifecycle;
  /** Maximum age of an active runner row before the sweeper reclaims it. */
  maxRunHours: number;
  /** How often the sweeper polls. */
  intervalMs?: number;
  /** Hook for surfacing reclaim events; defaults to a structured log line. */
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
        log.info("reclaimed abandoned runner", { runnerId: record.runnerId, runId: record.runId ?? undefined });
      });
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        log.error("sweeper error", {}, error);
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
