import type { MemoryDb, RepositoryVisibilityObservationRecord } from "./conformanceMemoryDb.js";

export interface RepositoryVisibilityConformanceClient {
  query<T = unknown>(rawSql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

/**
 * RLS-aware SQL fake for gv-11's immutable observation repository. It deliberately
 * recognizes only its SQL surface so a changed query must update this fake and its
 * exercising conformance test rather than silently passing against in-memory data.
 */
export function createRepositoryVisibilityConformanceClient(
  db: MemoryDb,
  orgId: string,
): RepositoryVisibilityConformanceClient {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async query<T = unknown>(
      rawSql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number }> {
      const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
      const projects = () => db.projects.filter((project) => project.org_id === orgId);
      const observations = () =>
        db.repositoryVisibilityObservations.filter((observation) => observation.org_id === orgId);

      if (/SELECT repo_url, repo_visibility FROM projects WHERE org_id = \$1 AND project_id = \$2/u.test(sql)) {
        const [requestedOrgId, projectId] = params as [string, string];
        const project = requestedOrgId === orgId ? projects().find((row) => row.project_id === projectId) : undefined;
        return result(
          project === undefined ? [] : [{ repo_url: project.repo_url, repo_visibility: project.repo_visibility }],
        );
      }
      if (/INSERT INTO repository_visibility_observations/u.test(sql)) {
        const [requestedOrgId, projectId, observationId, observedVisibility, forgeRef, sha] = params as [
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        if (requestedOrgId !== orgId || projects().every((project) => project.project_id !== projectId)) {
          throw new Error("repository_visibility_observations RLS policy rejected insert");
        }
        const row: RepositoryVisibilityObservationRecord = {
          org_id: requestedOrgId,
          project_id: projectId,
          observation_id: observationId,
          observed_visibility: observedVisibility,
          forge_ref: forgeRef,
          sha,
          observed_at: new Date("2026-01-01T00:00:00.000Z"),
        };
        db.repositoryVisibilityObservations.push(row);
        return result([row]);
      }
      if (/FROM repository_visibility_observations WHERE org_id = \$1 AND project_id = \$2/u.test(sql)) {
        const [requestedOrgId, projectId] = params as [string, string];
        const rows =
          requestedOrgId === orgId
            ? observations()
                .filter((observation) => observation.project_id === projectId)
                .sort((left, right) => right.observation_id.localeCompare(left.observation_id))
            : [];
        return result(rows);
      }
      if (/^(?:UPDATE|DELETE FROM) repository_visibility_observations/u.test(sql)) {
        const [requestedOrgId, observationId] = params as [string, string];
        const row =
          requestedOrgId === orgId
            ? observations().find((observation) => observation.observation_id === observationId)
            : undefined;
        if (row !== undefined) {
          throw new Error("repository_visibility_observations rows are immutable (append-only)");
        }
        return result([]);
      }
      throw new Error(`MemoryDb: unrecognized repository visibility SQL: ${sql}`);
    },
  };
}

function result<T>(rows: T[]): { rows: T[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}
