// The production assembly of the BatchMergeCoordinator (autonomy-engine.md §2d
// — speculative batch-check + bisect), wired from the merge-coordinator subscriber.
// It is the native-queue DRIVER: it forms a batch, proves the prospective merged
// state (`default_branch + batch PRs`) green as a COMBINED unit (the PgBatchChecker:
// speculative integration + the VcsProvider branch-CI seam), then drives
// the SAME per-run merges in DAG order — a bad interaction is bisected to ONE
// PR (recoverable dequeue → re-execution) rather than stalling the batch.
//
// It REUSES the native-queue pieces verbatim — the SAME PgMergeQueueModel (queue + lease),
// the SAME PgMergeRunner over `buildDriveMerge` (the real per-run merge path), the
// SAME PgMergeQueueEventEmitter (advanced / dequeued) — and ADDS the PgBatchChecker +
// PgBatchMergeEventEmitter (merge.batch.*). The max batch size is resolved per-project
// from `projects.config.maxBatchSize` (the config knob, the single source of truth).

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_MAX_BATCH_SIZE } from "../config/shared.js";
import type { MergeCoordinator } from "../contracts/mergeCoordinator.js";
import { PgBatchChecker } from "./batchChecker.js";
import { BatchMergeCoordinator } from "./batchCoordinator.js";
import { PgBatchMergeEventEmitter } from "./batchCoordinatorPg.js";
import { PgBatchGateReworkRouter } from "./batchGateReworkRouter.js";
import { PgSpecEscalator } from "./coordinatorEscalate.js";
import { type BuildMergeCoordinatorDeps, buildDriveMerge } from "./coordinatorBuild.js";
import { PgMergeQueueEventEmitter } from "./coordinatorEvents.js";
import { PgMergeQueueModel, PgMergeRunner, PgMergeSettleTransaction } from "./coordinatorPg.js";
import { PgHoldCeilingStore } from "./holdCeilingStore.js";

/**
 * apex v87: local both-or-neither settle (`PgMergeSettleTransaction`) opens
 * `PgEventStore` on the worker pool — only legal when the writer declares
 * `localMergeSettleCoTx` (Direct; pool can INSERT `events`). HttpRunStateWriter
 * omits the flag; wiring the local settle would throw
 * `permission denied for table events` on every dequeue (bisect / gate rework /
 * needs_attention / infra escalate) and fail the coordinate pass every ~15s.
 * Remote writers use sequential event-first through the writer-backed emitters.
 */
export function canCoTransactMergeSettle(writer: BuildMergeCoordinatorDeps["runStateWriter"]): boolean {
  return writer.localMergeSettleCoTx === true;
}

/**
 * Resolve a project's configured `maxBatchSize` (the batch cap) under the system
 * scope — the single config source of truth.
 *
 * no_silent_fallbacks: an ABSENT config (the `'{}'::jsonb` default a fresh project
 * carries; `isAbsentProjectConfig`) legitimately uses the schema default. But a
 * PRESENT-but-CORRUPT config must NOT be silently masked as the default — a corrupt
 * blob silently capping at the wrong batch size is a wrong-CAP fallback. A parse
 * failure PROPAGATES (loud, fail-closed) rather than being swallowed.
 */
export async function resolveMaxBatchSize(pool: pg.Pool, projectId: string): Promise<number> {
  const config = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.config;
  });
  if (isAbsentProjectConfig(config)) {
    return DEFAULT_MAX_BATCH_SIZE;
  }
  // Present config: a parse failure here is genuine corruption — let it propagate.
  return migrateProjectConfig(config).maxBatchSize;
}

/** Assemble the production BatchMergeCoordinator (the native-queue driver). */
export function buildBatchMergeCoordinator(deps: BuildMergeCoordinatorDeps): MergeCoordinator {
  const queueModel = new PgMergeQueueModel(deps.pool);
  // ATOMICITY (audit RC-4 #3) + plane-split (apex v87): co-transact event+queue UPDATE
  // ONLY when the writer is Direct (local pool can INSERT events). HttpRunStateWriter
  // omits `tx` → markDequeuedAfterEvent / markInfraBlockedAfterEvent use sequential
  // event-first through the writer-backed emitters (control plane owns the INSERT).
  const settleTx = canCoTransactMergeSettle(deps.runStateWriter)
    ? new PgMergeSettleTransaction(deps.pool, queueModel)
    : undefined;
  return new BatchMergeCoordinator({
    queue: queueModel,
    ...(settleTx !== undefined && { tx: settleTx }),
    // `buildDriveMerge(deps)` already threads `deps.runStateWriter` into the merge
    // stage + the spec-status finalize + the conflict re-execution.
    runner: new PgMergeRunner(buildDriveMerge(deps)),
    checker: new PgBatchChecker({
      pool: deps.pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      // The native batch gate provisions a fresh runner to gate the integration ref.
      allocator: deps.allocator,
      ssh: deps.ssh,
      identitySecretRef: deps.identitySecretRef,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      runStateWriter: deps.runStateWriter,
    }),
    // Audit finding D3/H3 sweep: writer ALWAYS wired (Direct or HTTP); the queue
    // event emitters route every event through it.
    events: new PgMergeQueueEventEmitter(deps.pool, deps.runStateWriter),
    batchEvents: new PgBatchMergeEventEmitter(deps.pool, deps.runStateWriter),
    // The §2c non-bricking conflict escalator (parks an irreconcilable spec at
    // needs_attention) — REUSED verbatim from the native queue, routes through the writer.
    escalator: new PgSpecEscalator(deps.pool, deps.runStateWriter),
    // The batch-gate-fail self-heal (v35 — the strand fix): a GATE-fail bisect culprit
    // (code that passed its own branch gates but breaks integrated) is routed back to the
    // WRITER for rework carrying the gate error as steering, REUSING the never-discard
    // re-plan-with-steering enqueuer + bounded by its own budget — DISTINCT from the
    // conflict-replan route. Always uses the writer.
    gateRework: new PgBatchGateReworkRouter({
      pool: deps.pool,
      runStateWriter: deps.runStateWriter,
    }),
    // Audit RC-7: the DURABLE backing store for both runaway-guard ceilings (per-project
    // consecutive-infra-hold streak + per-entry recoverable-drive attempts), so the counters
    // survive a rolling deploy / crash-loop instead of resetting in a process-local Map.
    holdCeilingStore: new PgHoldCeilingStore(deps.pool),
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
