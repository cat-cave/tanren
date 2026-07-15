import type { ActorContext } from "../../auth/schemas.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export type IntegrationProjectAccess = "allowed" | "not_found" | "denied";

/** Project-scoped integration effects require project membership, not just org scope. */
export async function integrationProjectAccess(
  client: IntegrationQueryClient,
  orgId: string,
  projectId: string,
  actor: ActorContext,
): Promise<IntegrationProjectAccess> {
  const project = await client.query("SELECT project_id FROM projects WHERE org_id = $1 AND project_id = $2", [
    orgId,
    projectId,
  ]);
  if (project.rows[0] === undefined) return "not_found";
  if (actor.scopes.includes("platform:admin") || actor.scopes.includes("org:admin")) return "allowed";
  if (
    actor.projectId === projectId &&
    (actor.scopes.includes("project:member") || actor.scopes.includes("project:admin"))
  ) {
    return "allowed";
  }
  const membership = await client.query("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2", [
    projectId,
    actor.userId,
  ]);
  return membership.rows[0] === undefined ? "denied" : "allowed";
}
