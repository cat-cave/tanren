// The per-project GOVERNANCE surface: the OBSERVATION + MUTATION endpoints for
// the governance settings that decide whether the autonomous DagWalker can
// advance a project (apex.md "missing endpoint → add it"). This is the SUPPORTED
// way to flip an existing project to autonomous — an operator never hand-crafts a
// full-config PATCH to change these.
//
//   GET  /:orgId/projects/:projectId/governance
//     → { reviewPolicy, mergeIntegration, governancePosture, auditPosture,
//         insightThresholds }
//       the governed settings the run loop consults: whether review requires a
//       human verdict (`reviewPolicy`), which merge engine the PR enters
//       (`mergeIntegration`), the escape-hatch posture (`governancePosture`), the
//       audit-posture DORA knob (`auditPosture`), and the CI-intelligence
//       thresholds (`insightThresholds`).
//   PUT  /:orgId/projects/:projectId/governance
//        { reviewPolicy?, mergeIntegration?, governancePosture?, auditPosture?,
//          insightThresholds? }
//     → the same shape, re-read after the write. Read-modify-writes the keys on
//       `projects.config` through the SAME versioned project-config path the rest
//       of the config uses — a dedicated, discoverable endpoint mirroring the budget
//       surface. Omitted fields are left untouched.
//
// Both run org-scoped under RLS: the config read-modify-write resolves + verifies
// the project's org first. The MUTATION is org-admin authorized (it changes the
// autonomy posture), stronger than the read — mirroring the org-config gate.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import {
  AuditPostureConfig,
  GovernancePosture,
  MergeIntegration,
  migrateProjectConfig,
  ReviewPolicy,
} from "../../engine/config/index.js";
import { InsightThresholdsConfig } from "../../engine/insights/thresholds.js";
import { mutateProjectConfig, ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";

// Every field is optional: a PUT overrides only the settings it names; omitted
// keys keep their current value (read-modify-write). `.strict()` rejects unknown keys.
export const GovernancePutSchema = z
  .object({
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
}

function toView(config: ReturnType<typeof migrateProjectConfig>): GovernanceView {
  return {
    reviewPolicy: config.reviewPolicy,
    mergeIntegration: config.mergeIntegration,
    governancePosture: config.governancePosture,
    auditPosture: config.auditPosture,
    insightThresholds: config.insightThresholds,
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
  const config = migrateProjectConfig(await ProjectStore.getConfig(pool, projectId, systemActor));
  return c.json(toView(config));
}

/**
 * PUT handler: set the project's governance settings by read-modify-writing the
 * named keys on `projects.config`, then re-read + return the resolved view. Only
 * the named fields change; the rest of the config round-trips untouched through
 * the versioned parser so the persisted blob is always a valid ProjectConfigV1.
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

  const validated = await mutateProjectConfig(pool, projectId, systemActor, (raw) => {
    const current = migrateProjectConfig(raw);
    return migrateProjectConfig({
      ...current,
      ...(body.reviewPolicy === undefined ? {} : { reviewPolicy: body.reviewPolicy }),
      ...(body.mergeIntegration === undefined ? {} : { mergeIntegration: body.mergeIntegration }),
      ...(body.governancePosture === undefined ? {} : { governancePosture: body.governancePosture }),
      ...(body.auditPosture === undefined ? {} : { auditPosture: body.auditPosture }),
      ...(body.insightThresholds === undefined ? {} : { insightThresholds: body.insightThresholds }),
    });
  });

  return c.json(toView(validated));
}
