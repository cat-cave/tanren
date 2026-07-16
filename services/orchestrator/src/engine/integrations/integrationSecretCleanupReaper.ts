import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { SecretStore } from "../contracts/secretStore.js";
import { createLogger } from "../observability/logger.js";
import {
  IntegrationConnectionsStore,
  type TerminalStagedCleanupCandidate,
} from "../repositories/integrationConnections.js";

const log = createLogger("integration-secret-cleanup-reaper");

export interface IntegrationSecretCleanupReaperOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  intervalMs?: number;
}

/**
 * Reconciles terminal integration operations that retained staged credentials.
 * The terminal database receipt is the authority; external deletion happens
 * outside a transaction, then an exact terminal CAS clears the durable intent.
 */
export class IntegrationSecretCleanupReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopped = false;

  constructor(private readonly options: IntegrationSecretCleanupReaperOptions) {}

  get isRunning(): boolean {
    return this.timer !== undefined && !this.stopped;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => 0);
  }

  async tick(): Promise<number> {
    if (this.stopped || this.inFlight !== undefined) return 0;
    const running = this.reap();
    this.inFlight = running;
    try {
      return await running;
    } finally {
      if (this.inFlight === running) this.inFlight = undefined;
    }
  }

  private async reap(): Promise<number> {
    let candidates: TerminalStagedCleanupCandidate[];
    try {
      candidates = await runWithSystemScope(this.options.pool, (client) =>
        IntegrationConnectionsStore.listTerminalStagedCleanupCandidates(client),
      );
    } catch (error) {
      log.error("failed to list terminal staged credentials; retrying next tick", {}, error);
      return 0;
    }

    let cleaned = 0;
    for (const candidate of candidates) {
      try {
        await this.options.secrets.delete(candidate.stagedSecretHandle);
        const cleared = await runWithSystemScope(this.options.pool, async (client) =>
          IntegrationConnectionsStore.markTerminalStagedCleanupComplete(client, candidate),
        );
        if (cleared) cleaned += 1;
      } catch (error) {
        log.warn(
          "terminal staged credential cleanup failed; retrying next tick",
          { operationId: candidate.operationId },
          error,
        );
      }
    }
    return cleaned;
  }
}
