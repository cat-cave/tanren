import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const RepositoryVisibility = z.enum(["public", "private"]);
export type RepositoryVisibility = z.infer<typeof RepositoryVisibility>;

export const RepositoryVisibilityObservation = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  observationId: z.string().min(1),
  observedVisibility: RepositoryVisibility,
  forgeRef: z.string().min(1),
  sha: z.string().min(1),
  observedAt: z.date(),
});
export type RepositoryVisibilityObservation = z.infer<typeof RepositoryVisibilityObservation>;

export interface ProjectRepositoryVisibility {
  readonly repoUrl: string;
  readonly declaredVisibility: RepositoryVisibility | null;
}

interface RawObservation {
  org_id: unknown;
  project_id: unknown;
  observation_id: unknown;
  observed_visibility: unknown;
  forge_ref: unknown;
  sha: unknown;
  observed_at: unknown;
}

interface RawProjectVisibility {
  repo_url: unknown;
  repo_visibility: unknown;
}

function decodeObservation(row: RawObservation): RepositoryVisibilityObservation {
  return RepositoryVisibilityObservation.parse({
    orgId: row.org_id,
    projectId: row.project_id,
    observationId: row.observation_id,
    observedVisibility: row.observed_visibility,
    forgeRef: row.forge_ref,
    sha: row.sha,
    observedAt: row.observed_at,
  });
}

function decodeProjectVisibility(row: RawProjectVisibility): ProjectRepositoryVisibility {
  return {
    repoUrl: z.string().min(1).parse(row.repo_url),
    declaredVisibility: row.repo_visibility === null ? null : RepositoryVisibility.parse(row.repo_visibility),
  };
}

export interface RecordRepositoryVisibilityObservationInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly observedVisibility: RepositoryVisibility;
  readonly forgeRef: string;
  readonly sha: string;
}

/** Org-scoped immutable forge visibility attestations. */
export const RepositoryVisibilityObservationsStore = {
  async getProject(
    client: QueryClient,
    orgId: string,
    projectId: string,
  ): Promise<ProjectRepositoryVisibility | undefined> {
    const result = await client.query<RawProjectVisibility>(
      `SELECT repo_url, repo_visibility
         FROM projects
        WHERE org_id = $1 AND project_id = $2`,
      [orgId, projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeProjectVisibility(row);
  },

  async record(
    client: QueryClient,
    input: RecordRepositoryVisibilityObservationInput,
  ): Promise<RepositoryVisibilityObservation> {
    const observationId = `repo_visibility_${randomUUID()}`;
    const result = await client.query<RawObservation>(
      `INSERT INTO repository_visibility_observations
         (org_id, project_id, observation_id, observed_visibility, forge_ref, sha)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING org_id, project_id, observation_id, observed_visibility, forge_ref, sha, observed_at`,
      [input.orgId, input.projectId, observationId, input.observedVisibility, input.forgeRef, input.sha],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `repository visibility observation was not recorded for ${input.orgId}/${input.projectId}; row is absent or outside scope`,
      );
    }
    return decodeObservation(row);
  },

  async list(client: QueryClient, orgId: string, projectId: string): Promise<RepositoryVisibilityObservation[]> {
    const result = await client.query<RawObservation>(
      `SELECT org_id, project_id, observation_id, observed_visibility, forge_ref, sha, observed_at
         FROM repository_visibility_observations
        WHERE org_id = $1 AND project_id = $2
        ORDER BY observed_at DESC, observation_id DESC`,
      [orgId, projectId],
    );
    return result.rows.map(decodeObservation);
  },
} as const;
