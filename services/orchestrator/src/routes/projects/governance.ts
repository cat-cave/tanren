// The per-project GOVERNANCE surface: the OBSERVATION + MUTATION endpoints for
// the three governance settings that decide whether the autonomous DagWalker can
// advance a project (apex.md "missing endpoint → add it"). This is the SUPPORTED
// way to flip an existing project to autonomous — an operator never hand-crafts a
// full-config PATCH to change these.
//
//   GET  /:orgId/projects/:projectId/governance
//     → { reviewPolicy, mergeIntegration, governancePosture }
//       the three governed settings the run loop consults: whether review requires
//       a human verdict (`reviewPolicy`), which merge engine the PR enters
//       (`mergeIntegration`), and the escape-hatch posture (`governancePosture`).
//   PUT  /:orgId/projects/:projectId/governance
//        { reviewPolicy?, mergeIntegration?, governancePosture? }
//     → the same shape, re-read after the write. Read-modify-writes the three keys
//       on `projects.config` through the SAME versioned project-config path the rest
//       of the config uses — a dedicated, discoverable endpoint mirroring the budget
//       surface. Omitted fields are left untouched.
//
// Both run org-scoped under RLS: the config read-modify-write resolves + verifies
// the project's org first. The MUTATION is org-admin authorized (it changes the
// autonomy posture), stronger than the read — mirroring the org-config gate.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { GovernancePosture, MergeIntegration, migrateProjectConfig, ReviewPolicy } from "../../engine/config/index.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";

// Every field is optional: a PUT overrides only the settings it names; omitted
// keys keep their current value (read-modify-write). `.strict()` rejects unknown keys.
export const GovernancePutSchema = z
  .object({
    reviewPolicy: ReviewPolicy.optional(),
    mergeIntegration: MergeIntegration.optional(),
    governancePosture: GovernancePosture.optional(),
  })
  .strict();

/** The read-shape both GET and PUT return — the operator governance surface. */
export interface GovernanceView {
  reviewPolicy: z.infer<typeof ReviewPolicy>;
  mergeIntegration: z.infer<typeof MergeIntegration>;
  governancePosture: z.infer<typeof GovernancePosture>;
}

function toView(config: ReturnType<typeof migrateProjectConfig>): GovernanceView {
  return {
    reviewPolicy: config.reviewPolicy,
    mergeIntegration: config.mergeIntegration,
    governancePosture: config.governancePosture,
  };
}

/** GET handler: resolve the project's config + render the three governance settings. */
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
 * three keys on `projects.config`, then re-read + return the resolved view. Only
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

  const current = migrateProjectConfig(await ProjectStore.getConfig(pool, projectId, systemActor));
  const nextConfig = {
    ...current,
    ...(body.reviewPolicy === undefined ? {} : { reviewPolicy: body.reviewPolicy }),
    ...(body.mergeIntegration === undefined ? {} : { mergeIntegration: body.mergeIntegration }),
    ...(body.governancePosture === undefined ? {} : { governancePosture: body.governancePosture }),
  };
  // Round-trip through the versioned parser so the persisted blob is always a valid
  // ProjectConfigV1.
  const validated = migrateProjectConfig(nextConfig);
  await ProjectStore.updateConfig(pool, projectId, validated, systemActor);

  return c.json(toView(validated));
}
