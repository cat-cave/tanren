// The production assembly of the P2d-2 BatchMergeCoordinator (autonomy-engine.md §2d
// — speculative batch-check + bisect), wired from the merge-coordinator subscriber.
// It is the native-queue DRIVER: it forms a batch, proves the prospective merged
// state (`default_branch + batch PRs`) green as a COMBINED unit (the PgBatchChecker:
// speculative integration via P2c-1 + the VcsProvider branch-CI seam), then drives
// the SAME P2d-1 per-run merges in DAG order — a bad interaction is bisected to ONE
// PR (recoverable dequeue → re-execution) rather than stalling the batch.
//
// It REUSES the P2d-1 pieces verbatim — the SAME PgMergeQueueModel (queue + lease),
// the SAME PgMergeRunner over `buildDriveMerge` (the real per-run merge path), the
// SAME PgMergeQueueEventEmitter (advanced / dequeued) — and ADDS the PgBatchChecker +
// PgBatchMergeEventEmitter (merge.batch.*). The max batch size is resolved per-project
// from `projects.config.maxBatchSize` (the config knob, the single source of truth).

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_MAX_BATCH_SIZE } from "../config/shared.js";
import type { MergeCoordinator } from "../contracts/mergeCoordinator.js";
import { PgBatchChecker } from "./batchChecker.js";
import { BatchMergeCoordinator } from "./batchCoordinator.js";
import { PgBatchMergeEventEmitter } from "./batchCoordinatorPg.js";
import { PgSpecEscalator } from "./coordinatorEscalate.js";
import { type BuildMergeCoordinatorDeps, buildDriveMerge } from "./coordinatorBuild.js";
import { PgMergeQueueEventEmitter } from "./coordinator.js";
import { PgMergeQueueModel, PgMergeRunner } from "./coordinatorPg.js";

/**
 * Resolve a project's configured `maxBatchSize` (the P2d-2 batch cap) under the system
 * scope — the single config source of truth. Falls back to the schema default if the
 * project/config cannot be read (never a hard error in the coordinator hot path).
 */
async function resolveMaxBatchSize(pool: pg.Pool, projectId: string): Promise<number> {
  try {
    const config = await runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
        projectId,
      ]);
      return result.rows[0]?.config;
    });
    return migrateProjectConfig(config).maxBatchSize;
  } catch {
    return DEFAULT_MAX_BATCH_SIZE;
  }
}

/** Assemble the production P2d-2 BatchMergeCoordinator (the native-queue driver). */
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
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    }),
    // Plane-split: route the queue/batch event emissions through the control plane
    // when wired; else direct on the pool (byte-identical).
    events: new PgMergeQueueEventEmitter(deps.pool, deps.runStateWriter),
    batchEvents: new PgBatchMergeEventEmitter(deps.pool, deps.runStateWriter),
    // The §2c non-bricking conflict escalator (parks an irreconcilable spec at
    // needs_attention) — REUSED verbatim from P2d-1, plane-split-safe via the writer.
    escalator: new PgSpecEscalator(deps.pool, deps.runStateWriter),
    resolveMaxBatchSize: (projectId) => resolveMaxBatchSize(deps.pool, projectId),
  });
}
