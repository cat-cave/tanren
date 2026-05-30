// P2A-0019 shared authz helpers for Forge tools. Mirrors the access checks
// used by P2A-0013 routes so every tool enforces the same gate. Tools call
// into these before reading or writing.

import type { ActorContext } from "../../../auth/schemas.js";
import type { QueryClient } from "../../data/orgScopedDb.js";

export class ToolAccessDeniedError extends Error {}

// RLS R3a: these gates read tenant tables (projects/runs/specs/project_members)
// and run inside the forge-tool dispatch. They take a `QueryClient` — the
// caller passes the ambient org-scoped client (via `resolveQueryClient`) so the
// gate read carries org context; a raw pool still satisfies the type (the
// recovery route + any unscoped caller fall back to pool, inert in R1).
export async function assertProjectAccess(
  pool: QueryClient,
  projectId: string,
  actor: ActorContext,
): Promise<{ orgId: string }> {
  // org_id is now mandatory on projects (tanren tenancy hardening): there is no
  // null-org bypass. A missing project (or, defensively, a project with no org)
  // is denied, never granted.
  const projectResult = await pool.query<{ org_id: string | null }>(
    "SELECT org_id FROM projects WHERE project_id = $1",
    [projectId],
  );
  const orgId = projectResult.rows[0]?.org_id ?? null;
  if (orgId === null) {
    throw new ToolAccessDeniedError(`actor cannot access project ${projectId}`);
  }
  if (actor.scopes.includes("platform:admin")) {
    return { orgId };
  }
  const member = await pool.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId],
  );
  if ((member.rowCount ?? 0) > 0) return { orgId };
  if (actor.orgId === orgId && (actor.scopes.includes("org:member") || actor.scopes.includes("org:admin"))) {
    return { orgId };
  }
  throw new ToolAccessDeniedError(`actor cannot access project ${projectId}`);
}

export async function assertRunAccess(
  pool: QueryClient,
  runId: string,
  actor: ActorContext,
): Promise<{ projectId: string; specId: string }> {
  const result = await pool.query<{ project_id: string; spec_id: string }>(
    "SELECT project_id, spec_id FROM runs WHERE run_id = $1",
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ToolAccessDeniedError(`run not found: ${runId}`);
  }
  await assertProjectAccess(pool, row.project_id, actor);
  return { projectId: row.project_id, specId: row.spec_id };
}

export async function assertSpecAccess(
  pool: QueryClient,
  specId: string,
  actor: ActorContext,
): Promise<{ projectId: string }> {
  const result = await pool.query<{ project_id: string }>("SELECT project_id FROM specs WHERE spec_id = $1", [specId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new ToolAccessDeniedError(`spec not found: ${specId}`);
  }
  await assertProjectAccess(pool, row.project_id, actor);
  return { projectId: row.project_id };
}
