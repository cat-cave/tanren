// The pg-backed batch-event emitter for the BatchMergeCoordinator (autonomy-engine.md
// §2d — speculative batch-check + bisect). Resolves the project's org, then writes
// each merge.batch.* event through the org-scoped PgEventStore (the single
// event-writer seam). The events carry the batch composition + cap stats + the bisect
// culprit so the timeline shows the batch decision; the culprit event carries the
// run/spec so the recoverable re-execution dequeue links back.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import type { BatchFormation } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";

function membersOf(batch: ReadonlyArray<MergeQueueEntry>): Array<{ specId: string; prNumber: number }> {
  return batch.map((e) => ({ specId: e.specId, prNumber: e.prNumber }));
}

export class PgBatchMergeEventEmitter implements BatchMergeEventEmitter {
  constructor(private readonly pool: pg.Pool) {}

  private async withScopedStore(projectId: string, work: (store: PgEventStore) => Promise<void>): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, (client) => work(new PgEventStore(client)));
  }

  async emitChecking(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void> {
    const head = input.batch[0];
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        eventType: "merge.batch.checking",
        payload: {
          integration: "native_queue",
          members: membersOf(input.batch),
          eligibleCount: input.formation.eligibleCount,
          capped: input.formation.capped,
          maxBatchSize: input.maxBatchSize,
        },
      }),
    );
  }

  async emitPassed(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    integrationBranch: string;
  }): Promise<void> {
    const head = input.batch[0];
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        eventType: "merge.batch.passed",
        payload: {
          integration: "native_queue",
          members: membersOf(input.batch),
          integrationBranch: input.integrationBranch,
        },
      }),
    );
  }

  async emitBisecting(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    message: string;
  }): Promise<void> {
    const head = input.batch[0];
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        eventType: "merge.batch.bisecting",
        payload: {
          integration: "native_queue",
          members: membersOf(input.batch),
          message: input.message,
        },
      }),
    );
  }

  async emitCulprit(input: {
    projectId: string;
    culprit: MergeQueueEntry;
    checks: number;
    message: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "merge.batch.culprit",
        payload: {
          integration: "native_queue",
          specId: input.culprit.specId,
          runId: input.culprit.runId,
          prNumber: input.culprit.prNumber,
          checks: input.checks,
          message: input.message,
        },
      }),
    );
  }
}
