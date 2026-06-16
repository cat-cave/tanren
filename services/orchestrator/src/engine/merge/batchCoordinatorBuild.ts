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

/** The timeout (ms) the native batch gate's clone/install/gate ops run under (mirrors the drive resolver). */
const BATCH_GATE_TIMEOUT_MS = 600_000;

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
  return new BatchMergeCoordinator({
    queue: queueModel,
    // ATOMICITY (audit RC-4 #3): the both-or-neither dequeue settle transaction — the
    // event append + the queue UPDATE share ONE org-scoped transaction so a crash
    // between them can never split the bus from the row. Only in the IN-PROCESS path:
    // a plane-split data plane (runStateWriter wired) routes events through the control
    // plane and cannot co-transact them with the local UPDATE, so it falls back to the
    // sequential event-first settle (the long-standing split-brain guard still holds).
    ...(deps.runStateWriter === undefined && { tx: new PgMergeSettleTransaction(deps.pool, queueModel) }),
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
      timeoutMs: BATCH_GATE_TIMEOUT_MS,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
    // Plane-split: route the queue/batch event emissions through the control plane
    // when wired; else direct on the pool (byte-identical).
    events: new PgMergeQueueEventEmitter(deps.pool, deps.runStateWriter),
    batchEvents: new PgBatchMergeEventEmitter(deps.pool, deps.runStateWriter),
    // The §2c non-bricking conflict escalator (parks an irreconcilable spec at
    // needs_attention) — REUSED verbatim from the native queue, plane-split-safe via the writer.
    escalator: new PgSpecEscalator(deps.pool, deps.runStateWriter),
    // The batch-gate-fail self-heal (v35 — the strand fix): a GATE-fail bisect culprit
    // (code that passed its own branch gates but breaks integrated) is routed back to the
    // WRITER for rework carrying the gate error as steering, REUSING the never-discard
    // re-plan-with-steering enqueuer + bounded by its own budget — DISTINCT from the
    // conflict-replan route. Plane-split-safe via the writer.
    gateRework: new PgBatchGateReworkRouter({
      pool: deps.pool,
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
    // Audit RC-7: the DURABLE backing store for both runaway-guard ceilings (per-project
    // consecutive-infra-hold streak + per-entry recoverable-drive attempts), so the counters
    // survive a rolling deploy / crash-loop instead of resetting in a process-local Map.
    holdCeilingStore: new PgHoldCeilingStore(deps.pool),
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
