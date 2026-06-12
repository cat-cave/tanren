// The project dependency-UPGRADE handler (environment-management.md §4.5/§7 P1).
//
//   POST /:orgId/projects/:projectId/upgrade
//     Generates a version-change DAG NODE for the project's dependency upgrade and
//     inserts it via the EXISTING spec-creation path (`acceptProposals` → `createSpec`
//     → the DAG) — the SAME hand-off the operator's discovery accept and the autonomous
//     intake/audit loops use. The DagWalker then drives the new spec through the full
//     gate (tiers + build): green merges, a breaking bump is rejected loudly and main
//     stays green. There is NO un-gated dependency mutation here.
//     → 201 { generated: true, specId }   — a gated node was inserted into the DAG.
//     → 200 { generated: false, reason }  — a SEMANTIC refusal (the project is pinned,
//                                           or declares no `upgrade` verb).
//
// The on-demand trigger; the proactive triggers (scheduled freshness pass, CVE-advisory
// ingestion) are documented FOLLOW-ON work (§4.5 motivation 2 / §6). The handler lives
// here (mirroring `lifecycle.ts`) so the project route file stays under its dependency +
// line caps; it is mounted by `projects/index.ts`.

import type { Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { generateUpgradeSpec } from "../../engine/forge/upgrade/index.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";

/**
 * POST upgrade handler. Generates + inserts the upgrade DAG node (or returns a semantic
 * refusal). The org-access guard runs in the route before this is called.
 */
export async function handleProjectUpgrade(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  actor: ActorContext,
): Promise<Response> {
  try {
    const result = await generateUpgradeSpec({ pool }, { orgId, projectId, actor });
    if (result.kind === "refused") {
      return c.json({ generated: false, reason: result.reason }, 200);
    }
    return c.json({ generated: true, specId: result.specId }, 201);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return c.json({ error: "project_not_found", message: error.message }, 404);
    }
    if (error instanceof ProjectAccessDeniedError) {
      return c.json({ error: "project_access_denied", message: error.message }, 403);
    }
    if (error instanceof SpecNotFoundError) {
      return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
    }
    return c.json(
      { error: "upgrade_generate_failed", message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}
