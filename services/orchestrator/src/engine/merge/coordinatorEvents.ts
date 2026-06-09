// The pg-backed native-queue event emitters (extracted from coordinator.ts to keep
// each file ≤500 lines). `PgMergeQueueEventEmitter` resolves the project's org +
// opens the scope; `ClientBoundMergeQueueEventEmitter` owns the single-sourced event
// payload shapes and writes them through whatever EventStore it is handed — the
// org-scoped store, an in-transaction one (the both-or-neither settle, audit RC-4 #3),
// or the plane-split writer.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { DequeueReason, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";

/**
 * A queue-event emitter bound to a SINGLE already-resolved {@link EventStore} (an
 * org-scoped `PgEventStore`, an in-transaction one, or the plane-split writer). It
 * owns ONLY the event payload shapes — no org resolution, no scope opening — so the
 * SAME payloads are emitted whether the append runs standalone (`PgMergeQueueEventEmitter`)
 * or inside the both-or-neither settle transaction (`PgMergeSettleTransaction`,
 * audit RC-4 #3). Single-sourcing the payloads keeps the two paths from drifting.
 */
export class ClientBoundMergeQueueEventEmitter implements MergeQueueEventEmitter {
  constructor(private readonly store: EventStore) {}

  async emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    await this.store.append({
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.projectId,
      eventType: "merge.queue.advanced",
      payload: {
        prUrl: input.entry.prUrl,
        prNumber: input.entry.prNumber,
        integration: "native_queue",
        specId: input.entry.specId,
        queueDepth: input.queueDepth,
      },
    });
  }

  async emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: DequeueReason;
    message: string;
  }): Promise<void> {
    await this.store.append({
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.projectId,
      eventType: "merge.dequeued",
      payload: {
        prUrl: input.entry.prUrl,
        prNumber: input.entry.prNumber,
        integration: "native_queue",
        specId: input.entry.specId,
        reason: input.reason,
        message: input.message,
      },
    });
  }

  async emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts: number;
    message: string;
  }): Promise<void> {
    await this.store.append({
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.projectId,
      eventType: "merge.queue.infra_blocked",
      payload: {
        prUrl: input.entry.prUrl,
        prNumber: input.entry.prNumber,
        integration: "native_queue",
        specId: input.entry.specId,
        kind: input.kind,
        attempts: input.attempts,
        message: input.message,
      },
    });
  }
}

/**
 * The pg-backed queue-event emitter. Resolves the project's org, then delegates to a
 * scope-bound {@link ClientBoundMergeQueueEventEmitter} so the event payloads are
 * single-sourced. The events carry the entry's run/spec so the timeline links the
 * queue decision to the run, and the queue depth for queue/stack statistics (§2d).
 */
export class PgMergeQueueEventEmitter implements MergeQueueEventEmitter {
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, queue events
   *   append through the control-plane writer (the de-privileged data plane can no
   *   longer write `events` directly); absent, in-process via `PgEventStore`.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  private async withScopedEmitter(
    projectId: string,
    work: (emitter: MergeQueueEventEmitter) => Promise<void>,
  ): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    // Plane-split: route the event append through the control plane when wired (the
    // writer resolves the run's org from the ambient per-job org-id, so set it for
    // the append); else append in-process under a short org scope — byte-identical.
    if (this.runStateWriter !== undefined) {
      const writer = this.runStateWriter;
      await runWithJobOrgId(orgId, () => work(new ClientBoundMergeQueueEventEmitter(writer)));
      return;
    }
    await runWithOrgScope(this.pool, orgId, (client) =>
      work(new ClientBoundMergeQueueEventEmitter(new PgEventStore(client))),
    );
  }

  async emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    await this.withScopedEmitter(input.projectId, (emitter) => emitter.emitAdvanced(input));
  }

  async emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: DequeueReason;
    message: string;
  }): Promise<void> {
    await this.withScopedEmitter(input.projectId, (emitter) => emitter.emitDequeued(input));
  }

  async emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts: number;
    message: string;
  }): Promise<void> {
    await this.withScopedEmitter(input.projectId, (emitter) => emitter.emitInfraBlocked(input));
  }
}
