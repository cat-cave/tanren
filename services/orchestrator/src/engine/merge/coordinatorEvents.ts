// The pg-backed native-queue event emitters (extracted from coordinator.ts to keep
// each file ≤500 lines). `PgMergeQueueEventEmitter` resolves the project's org +
// opens the scope; `ClientBoundMergeQueueEventEmitter` owns the single-sourced event
// payload shapes and writes them through whatever EventStore it is handed — the
// org-scoped store, an in-transaction one (the both-or-neither settle, audit RC-4 #3),
// or the plane-split writer.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { EventStore } from "../eventStore.js";
import type { DequeueReason, MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";

type DequeuedEventEntry = Pick<MergeQueueEntry, "runId" | "specId" | "prUrl" | "prNumber">;

/** Canonical `merge.dequeued` append shared by sequential and atomic settlement. */
export async function appendMergeDequeuedEvent(
  store: EventStore,
  orgId: string,
  input: {
    projectId: string;
    entry: DequeuedEventEntry;
    reason: DequeueReason;
    message: string;
  },
): Promise<void> {
  await store.append({
    runId: input.entry.runId,
    specId: input.entry.specId,
    projectId: input.projectId,
    orgId,
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

/**
 * A queue-event emitter bound to a SINGLE already-resolved {@link EventStore} (an
 * org-scoped `PgEventStore`, an in-transaction one, or the plane-split writer). It
 * owns ONLY the event payload shapes — no org resolution, no scope opening — so the
 * SAME payloads are emitted through the writer-backed queue surface. Recovery
 * settlement itself uses the writer's atomic queue authority.
 */
export class ClientBoundMergeQueueEventEmitter implements MergeQueueEventEmitter {
  /**
   * @param store The resolved event store (org-scoped, in-transaction, or plane-split writer).
   * @param orgId The resolved project org — stamped onto every emitted event so the row
   *   carries the explicit tenant key (the v68 fix; no derive-from-project subquery).
   */
  constructor(
    private readonly store: EventStore,
    private readonly orgId: string,
  ) {}

  async emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    await this.store.append({
      runId: input.entry.runId,
      specId: input.entry.specId,
      projectId: input.projectId,
      orgId: this.orgId,
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
    await appendMergeDequeuedEvent(this.store, this.orgId, input);
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
      orgId: this.orgId,
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
   * @param runStateWriter REQUIRED (audit D-R3.2 sweep): queue events route through the
   *   writer seam — the de-privileged data plane cannot write `events` directly. PR #714
   *   made the writer-undefined arm unreachable in production.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter,
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
    // v68 fix: pass `orgId` into the emitter so every event.append stamps it directly.
    const writer = this.runStateWriter;
    await runWithJobOrgId(orgId, () => work(new ClientBoundMergeQueueEventEmitter(writer, orgId)));
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
