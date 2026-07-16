/**
 * Exact HTTP 409 vocabulary for a lost project-config CAS.
 * Intentionally limited to safe row identity + current revision. Richer
 * dashboard identity (e.g. repoUrl) is owned by #856, not this substrate.
 */
export function projectConfigConflict(
  orgId: string,
  projectId: string,
  revision: string,
): { error: "project_config_conflict"; orgId: string; projectId: string; revision: string } {
  return { error: "project_config_conflict", orgId, projectId, revision };
}

/**
 * Exact HTTP 409 vocabulary for a lost org-config CAS.
 * Same thin body rule as project — #856 owns richer consumer identity.
 */
export function orgConfigConflict(
  orgId: string,
  revision: string,
): { error: "org_config_conflict"; orgId: string; revision: string } {
  return { error: "org_config_conflict", orgId, revision };
}
