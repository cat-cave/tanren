// P2A-0019 shared authz helpers for Forge tools. Mirrors the access checks
// used by P2A-0013 routes so every tool enforces the same gate. Tools call
// into these before reading or writing.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";

export class ToolAccessDeniedError extends Error {}

export async function assertProjectAccess(
  pool: pg.Pool,
  projectId: string,
  actor: ActorContext
): Promise<{ orgId: string | null }> {
  if (actor.scopes.includes("platform:admin")) {
    const result = await pool.query<{ org_id: string | null }>(
      "SELECT org_id FROM projects WHERE project_id = $1",
      [projectId]
    );
    return { orgId: result.rows[0]?.org_id ?? null };
  }
  const projectResult = await pool.query<{ org_id: string | null }>(
    "SELECT org_id FROM projects WHERE project_id = $1",
    [projectId]
  );
  const orgId = projectResult.rows[0]?.org_id ?? null;
  if (orgId === null) {
    // Legacy / unscoped projects bypass org-scoping (mirrors
    // projectSpec.ensureProjectAccess).
    return { orgId };
  }
  const member = await pool.query<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, actor.userId]
  );
  if ((member.rowCount ?? 0) > 0) return { orgId };
  if (
    actor.orgId === orgId &&
    (actor.scopes.includes("org:member") || actor.scopes.includes("org:admin"))
  ) {
    return { orgId };
  }
  throw new ToolAccessDeniedError(`actor cannot access project ${projectId}`);
}

export async function assertRunAccess(
  pool: pg.Pool,
  runId: string,
  actor: ActorContext
): Promise<{ projectId: string; specId: string }> {
  const result = await pool.query<{ project_id: string; spec_id: string }>(
    "SELECT project_id, spec_id FROM runs WHERE run_id = $1",
    [runId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ToolAccessDeniedError(`run not found: ${runId}`);
  }
  await assertProjectAccess(pool, row.project_id, actor);
  return { projectId: row.project_id, specId: row.spec_id };
}

export async function assertSpecAccess(
  pool: pg.Pool,
  specId: string,
  actor: ActorContext
): Promise<{ projectId: string }> {
  const result = await pool.query<{ project_id: string }>(
    "SELECT project_id FROM specs WHERE spec_id = $1",
    [specId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ToolAccessDeniedError(`spec not found: ${specId}`);
  }
  await assertProjectAccess(pool, row.project_id, actor);
  return { projectId: row.project_id };
}
