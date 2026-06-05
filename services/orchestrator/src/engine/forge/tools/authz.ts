// shared authz helpers for Forge tools. Mirrors the access checks
// used by routes so every tool enforces the same gate. Tools call
// into these before reading or writing.

import type { ActorContext } from "../../../auth/schemas.js";
import type { QueryClient } from "../../data/orgScopedDb.js";
import { ForgeToolsStore } from "../../repositories/forgeTools.js";
import { systemActor } from "../../state/actor.js";

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
  const orgId = await ForgeToolsStore.getProjectOrgId(pool, projectId, systemActor);
  if (orgId === null) {
    throw new ToolAccessDeniedError(`actor cannot access project ${projectId}`);
  }
  if (actor.scopes.includes("platform:admin")) {
    return { orgId };
  }
  const memberCount = await ForgeToolsStore.countProjectMemberRole(pool, projectId, actor.userId, systemActor);
  if (memberCount > 0) return { orgId };
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
  const row = await ForgeToolsStore.getRunProjectAndSpec(pool, runId, systemActor);
  if (row === undefined) {
    throw new ToolAccessDeniedError(`run not found: ${runId}`);
  }
  await assertProjectAccess(pool, row.projectId, actor);
  return { projectId: row.projectId, specId: row.specId };
}

export async function assertSpecAccess(
  pool: QueryClient,
  specId: string,
  actor: ActorContext,
): Promise<{ projectId: string }> {
  const projectId = await ForgeToolsStore.getSpecProjectId(pool, specId, systemActor);
  if (projectId === undefined) {
    throw new ToolAccessDeniedError(`spec not found: ${specId}`);
  }
  await assertProjectAccess(pool, projectId, actor);
  return { projectId };
}
