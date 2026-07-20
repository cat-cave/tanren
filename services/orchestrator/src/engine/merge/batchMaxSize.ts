// The per-project batch-cap resolver, extracted from the coordinator assembly root so that
// root stays a thin composition wiring (import/max-dependencies). A PRESENT-but-CORRUPT config
// PROPAGATES (loud, fail-closed) rather than being silently masked as the default.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_MAX_BATCH_SIZE } from "./batchCoordinator.js";
// ds-6: re-exported here so `buildBatchMergeCoordinator` wires the design-delivery pre_merge
// binder through an existing import (the coordinator-assembly root's runtime-import cap).
export { buildDesignAwareDeliveryCoordinator } from "../design/queue/designAwareDeliveryCoordinator.js";

/**
 * Resolve a project's configured `maxBatchSize` (the batch cap) under the system scope — the
 * single config source of truth. An ABSENT config (the `'{}'::jsonb` default a fresh project
 * carries) legitimately uses the schema default; a parse failure PROPAGATES (never a wrong-CAP
 * silent fallback).
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
  return migrateProjectConfig(config).maxBatchSize;
}
