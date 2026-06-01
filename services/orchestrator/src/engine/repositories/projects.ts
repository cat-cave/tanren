import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The project row as the HTTP project/brownfield routes read it. `config` is an
// opaque JSON blob the route layer migrates/validates with `migrateProjectConfig`
// — the repository does not interpret it, so it stays `unknown` here.
export const ProjectRow = z.object({
  projectId: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  runnerImage: z.string(),
  allocator: z.string(),
  config: z.unknown(),
  orgId: z.string().nullable(),
});
export type ProjectRow = z.infer<typeof ProjectRow>;

interface RawProjectRow {
  project_id: unknown;
  name: unknown;
  repo_url: unknown;
  default_branch: unknown;
  runner_image: unknown;
  allocator: unknown;
  config: unknown;
  org_id: unknown;
}

const SELECT_PROJECT_COLUMNS = `
  project_id,
  name,
  repo_url,
  default_branch,
  runner_image,
  allocator,
  config,
  org_id
`;

function decodeProjectRow(raw: RawProjectRow): ProjectRow {
  return ProjectRow.parse({
    projectId: raw.project_id,
    name: raw.name,
    repoUrl: raw.repo_url,
    defaultBranch: raw.default_branch,
    runnerImage: raw.runner_image,
    allocator: raw.allocator,
    config: raw.config,
    orgId: raw.org_id,
  });
}

// A lightweight org-only projection used by routes that gate on a project's
// tenant before reading/writing (the brownfield link + posture writers, the
// project PATCH guard). Keeps those gates off raw `.query` without forcing a
// full row decode.
export const ProjectOwnership = z.object({
  orgId: z.string().nullable(),
  defaultBranch: z.string().nullable(),
});
export type ProjectOwnership = z.infer<typeof ProjectOwnership>;

export const ProjectStore = {
  /** All projects for an org, ordered by name (the project-list route). */
  async listForOrg(client: QueryClient, orgId: string, _actor: ActorRef): Promise<ProjectRow[]> {
    const result = await client.query(
      `SELECT ${SELECT_PROJECT_COLUMNS} FROM projects WHERE org_id = $1 ORDER BY name`,
      [orgId],
    );
    return result.rows.map((row) => decodeProjectRow(row as RawProjectRow));
  },

  /** A single project by id (no org filter; callers compare `orgId` themselves). */
  async get(client: QueryClient, projectId: string, _actor: ActorRef): Promise<ProjectRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_PROJECT_COLUMNS} FROM projects WHERE project_id = $1`, [
      projectId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeProjectRow(row as RawProjectRow);
  },

  /**
   * The org id (+ default branch) for a project, or `undefined` when no row
   * exists. The ownership gate every project-mutating route runs before writing.
   */
  async getOwnership(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<ProjectOwnership | undefined> {
    const result = await client.query(
      "SELECT org_id, default_branch FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0] as { org_id?: unknown; default_branch?: unknown } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return ProjectOwnership.parse({
      orgId: row.org_id ?? null,
      defaultBranch: row.default_branch ?? null,
    });
  },

  /** The raw stored `config` blob for a project (the posture/config writers read-modify-write it). */
  async getConfig(client: QueryClient, projectId: string, _actor: ActorRef): Promise<unknown> {
    const result = await client.query("SELECT config FROM projects WHERE project_id = $1", [projectId]);
    const row = result.rows[0] as { config?: unknown } | undefined;
    return row?.config;
  },

  /** Overwrite a project's `config` blob (the project PATCH + brownfield posture write). */
  async updateConfig(client: QueryClient, projectId: string, config: unknown, _actor: ActorRef): Promise<void> {
    await client.query("UPDATE projects SET config = $1::jsonb WHERE project_id = $2", [
      JSON.stringify(config),
      projectId,
    ]);
  },

  /** Set a project's repo URL (the brownfield link write). */
  async updateRepoUrl(client: QueryClient, projectId: string, repoUrl: string, _actor: ActorRef): Promise<void> {
    await client.query("UPDATE projects SET repo_url = $1 WHERE project_id = $2", [repoUrl, projectId]);
  },
} as const;
