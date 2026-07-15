import type pg from "pg";
import { migrateProjectConfig, type ProjectConfigV1 } from "../../engine/config/index.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import {
  checkFullProjectConfigPatch,
  type ProjectConfigWriteRejectionResponse,
} from "../../engine/workflow/projectConfigWriteGuards.js";

export type FullConfigPatchOutcome =
  | { kind: "updated"; config: ProjectConfigV1 }
  | { kind: "rejected"; response: ProjectConfigWriteRejectionResponse }
  | { kind: "not_found" }
  | { kind: "conflict" };

/**
 * Apply the member-writable full-config PATCH with an atomic compare-and-swap.
 * A concurrent governance PUT makes the CAS fail with an actionable conflict,
 * so it can never be overwritten by a stale member snapshot.
 */
export async function applyFullConfigPatch(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  rawConfig: Record<string, unknown>,
): Promise<FullConfigPatchOutcome> {
  const snapshot = await ProjectStore.getConfigSnapshot(pool, projectId, systemActor);
  if (snapshot === undefined || (snapshot.orgId !== null && snapshot.orgId !== orgId)) {
    return { kind: "not_found" };
  }

  const checked = checkFullProjectConfigPatch(rawConfig, migrateProjectConfig(snapshot.config));
  if (!checked.ok) return { kind: "rejected", response: checked.response };

  const updated = await ProjectStore.updateConfigIfCurrent(
    pool,
    projectId,
    orgId,
    snapshot.config,
    checked.config,
    systemActor,
  );
  return updated ? { kind: "updated", config: checked.config } : { kind: "conflict" };
}
