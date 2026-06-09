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
import { PgSpecEscalator } from "./coordinatorEscalate.js";
import { type BuildMergeCoordinatorDeps, buildDriveMerge } from "./coordinatorBuild.js";
import { PgMergeQueueEventEmitter } from "./coordinator.js";
import { PgMergeQueueModel, PgMergeRunner } from "./coordinatorPg.js";

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
  return new BatchMergeCoordinator({
    queue: new PgMergeQueueModel(deps.pool),
    // `buildDriveMerge(deps)` already threads `deps.runStateWriter` into the merge
    // stage + the spec-status finalize + the conflict re-execution.
    runner: new PgMergeRunner(buildDriveMerge(deps)),
    checker: new PgBatchChecker({
      pool: deps.pool,
      vcsProvider: deps.vcsProvider,
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
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
