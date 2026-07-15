// Project maxBatchSize resolution for the batch merge coordinator assembly.
// Extracted so batchCoordinatorBuild stays under the import-dependency cap.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_MAX_BATCH_SIZE } from "../config/shared.js";

/**
 * Resolve a project's configured `maxBatchSize` under the system scope.
 * Absent config uses the schema default; present-but-corrupt config fails closed.
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
