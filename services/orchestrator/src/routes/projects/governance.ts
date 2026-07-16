// The per-project GOVERNANCE surface: the OBSERVATION + MUTATION endpoints for
// the governance settings that decide whether the autonomous DagWalker can
// advance a project (apex.md "missing endpoint → add it"). This is the SUPPORTED
// way to flip an existing project to autonomous — an operator never hand-crafts a
// full-config PATCH to change these.
//
//   GET  /:orgId/projects/:projectId/governance
//     → { reviewPolicy, mergeIntegration, governancePosture, auditPosture,
//         insightThresholds, revision }
//   PUT  /:orgId/projects/:projectId/governance
//        { revision, reviewPolicy?, mergeIntegration?, governancePosture?,
//          auditPosture?, insightThresholds? }
//     → the same shape after a one-shot revision CAS. Omitted fields untouched.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { ConfigRevisionSchema } from "../../engine/config/configRevision.js";
import {
  AuditPostureConfig,
  GovernancePosture,
  MergeIntegration,
  migrateProjectConfig,
  ReviewPolicy,
} from "../../engine/config/index.js";
import { InsightThresholdsConfig } from "../../engine/insights/thresholds.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import { projectConfigConflict } from "./configConflict.js";

// Every field except revision is optional: a PUT overrides only the settings it
// names; omitted keys keep their current value (read-modify-write once).
export const GovernancePutSchema = z
  .object({
    revision: ConfigRevisionSchema,
    reviewPolicy: ReviewPolicy.optional(),
    mergeIntegration: MergeIntegration.optional(),
    governancePosture: GovernancePosture.optional(),
    auditPosture: AuditPostureConfig.optional(),
    insightThresholds: InsightThresholdsConfig.optional(),
  })
  .strict();

/** The read-shape both GET and PUT return — the operator governance surface. */
export interface GovernanceView {
  reviewPolicy: z.infer<typeof ReviewPolicy>;
  mergeIntegration: z.infer<typeof MergeIntegration>;
  governancePosture: z.infer<typeof GovernancePosture>;
  auditPosture: z.infer<typeof AuditPostureConfig>;
  insightThresholds: z.infer<typeof InsightThresholdsConfig>;
  revision: string;
}

function toView(config: ReturnType<typeof migrateProjectConfig>, revision: string): GovernanceView {
  return {
    reviewPolicy: config.reviewPolicy,
    mergeIntegration: config.mergeIntegration,
    governancePosture: config.governancePosture,
    auditPosture: config.auditPosture,
    insightThresholds: config.insightThresholds,
    revision,
  };
}

/** GET handler: resolve the project's config + render the governance settings. */
export async function handleGovernanceGet(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const snapshot = await ProjectStore.getConfigSnapshot(pool, projectId, systemActor);
  if (snapshot === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const config = migrateProjectConfig(snapshot.config);
  return c.json(toView(config, snapshot.revision));
}

/**
 * PUT handler: one-shot revision CAS over named governance keys on projects.config.
 * Field-merge is applied once against the snapshot matching `body.revision`.
 */
export async function handleGovernancePut(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  body: z.infer<typeof GovernancePutSchema>,
): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }

  const snapshot = await ProjectStore.getConfigSnapshot(pool, projectId, systemActor);
  if (snapshot === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  if (snapshot.revision !== body.revision) {
    return c.json(projectConfigConflict(orgId, projectId, snapshot.revision), 409);
  }

  const current = migrateProjectConfig(snapshot.config);
  const nextConfig = {
    ...current,
    ...(body.reviewPolicy === undefined ? {} : { reviewPolicy: body.reviewPolicy }),
    ...(body.mergeIntegration === undefined ? {} : { mergeIntegration: body.mergeIntegration }),
    ...(body.governancePosture === undefined ? {} : { governancePosture: body.governancePosture }),
    ...(body.auditPosture === undefined ? {} : { auditPosture: body.auditPosture }),
    ...(body.insightThresholds === undefined ? {} : { insightThresholds: body.insightThresholds }),
  };
  const validated = migrateProjectConfig(nextConfig);
  const outcome = await ProjectStore.compareAndSwapConfig(pool, projectId, body.revision, validated, systemActor);
  if (outcome.status === "not_found") {
    return c.json({ error: "project_not_found" }, 404);
  }
  if (outcome.status === "conflict") {
    return c.json(projectConfigConflict(orgId, projectId, outcome.current.revision), 409);
  }

  return c.json(toView(validated, outcome.revision));
}
