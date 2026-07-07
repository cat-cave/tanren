// The pg-backed batch-event emitter for the BatchMergeCoordinator (autonomy-engine.md
// §2d — speculative batch-check + bisect). Resolves the project's org, then writes
// each merge.batch.* event through the org-scoped PgEventStore (the single
// event-writer seam). The events carry the batch composition + cap stats + the bisect
// culprit so the timeline shows the batch decision; the culprit event carries the
// run/spec so the recoverable re-execution dequeue links back.

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { BatchFormation } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { createLogger } from "../observability/logger.js";
import type { BatchMergeEventEmitter } from "./batchCoordinator.js";

const log = createLogger("batch-merge-event-emitter");

function membersOf(batch: ReadonlyArray<MergeQueueEntry>): Array<{ specId: string; prNumber: number }> {
  return batch.map((e) => ({ specId: e.specId, prNumber: e.prNumber }));
}

export class PgBatchMergeEventEmitter implements BatchMergeEventEmitter {
  /**
   * @param runStateWriter REQUIRED (audit D-R3.2 sweep): merge.batch.* events append through
   *   the writer seam — the de-privileged data plane cannot write `events` directly, and
   *   PR #714 made the writer-undefined fallback unreachable in production.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter,
  ) {}

  private async withScopedStore(
    projectId: string,
    eventKind: string,
    work: (store: EventStore, orgId: string) => Promise<void>,
  ): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      // Observability fix (task #51 follow-up to PR #763 / PR #770): this branch
      // used to silently return when the project row was missing or its
      // `org_id` was NULL — the merge.batch.* event was DROPPED so the operator
      // could not see WHY without grepping engine logs. Mirrors the exact fail-
      // loud posture PR #763 introduced on `PgDagEventEmitter` and PR #770
      // extended to `PgPercolationEventEmitter`: log at ERROR with the projectId
      // + eventKind + a machine-parseable `unresolvable_project_org` reason so
      // an operator has a grep-able signal. We do NOT synthesize an org
      // (events.org_id NOT NULL + FK-tied — v68 jobReaper.ts rationale: never
      // fake tenancy to satisfy a NOT NULL).
      log.error("merge.batch event DROPPED — project org unresolvable", {
        projectId,
        eventKind,
        reason: "unresolvable_project_org",
      });
      return;
    }
    // v68 fix: thread the resolved orgId into the work callback so the event
    // append stamps the explicit tenant key (no derive-from-project subquery).
    const writer = this.runStateWriter;
    await runWithJobOrgId(orgId, () => work(writer, orgId));
  }

  async emitChecking(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void> {
    const head = input.batch[0];
    await this.withScopedStore(input.projectId, "merge.batch.checking", (store, orgId) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "merge.batch.passed", (store, orgId) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        orgId,
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
    await this.withScopedStore(input.projectId, "merge.batch.bisecting", (store, orgId) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        orgId,
        eventType: "merge.batch.bisecting",
        payload: {
          integration: "native_queue",
          members: membersOf(input.batch),
          message: input.message,
        },
      }),
    );
  }

  async emitInfraBlocked(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    message: string;
    attempts: number;
    terminal?: boolean;
    consecutiveHolds?: number;
    kind?: "missing_required_credential" | "ambiguous_merge_state";
  }): Promise<void> {
    const head = input.batch[0];
    await this.withScopedStore(input.projectId, "merge.batch.infra_blocked", (store, orgId) =>
      store.append({
        ...(head !== undefined && { runId: head.runId, specId: head.specId }),
        projectId: input.projectId,
        orgId,
        eventType: "merge.batch.infra_blocked",
        payload: {
          integration: "native_queue",
          members: membersOf(input.batch),
          message: input.message,
          attempts: input.attempts,
          // GAP #1 (runaway guard): mark the TERMINAL cross-pass ceiling escalation so
          // the timeline distinguishes the loud STOP from the recoverable in-pass hold.
          ...(input.terminal === true && { terminal: true }),
          ...(input.consecutiveHolds !== undefined && { consecutiveHolds: input.consecutiveHolds }),
          ...(input.kind !== undefined && { kind: input.kind }),
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
    await this.withScopedStore(input.projectId, "merge.batch.culprit", (store, orgId) =>
      store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        orgId,
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
