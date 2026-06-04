import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** A project's operator lifecycle: the autonomous-walker-driven default, or paused. */
const ProjectLifecycleEnum = z.enum(["active", "archived"]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleEnum>;

// The project row as the HTTP project/brownfield routes read it. `config` is an
// opaque JSON blob the route layer migrates/validates with `migrateProjectConfig`
// — the repository does not interpret it, so it stays `unknown` here. The SQL the
// methods emit is BYTE-IDENTICAL to the raw queries the routes issued before the
// move (this slice is a mechanical relocation behind the seam, not a rewrite):
// the project SELECT keeps the exact 7-column list (no `org_id`) the list/read
// routes used, and the ownership gates keep their original column shapes.
export const ProjectRow = z.object({
  projectId: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  runnerImage: z.string(),
  allocator: z.string(),
  config: z.unknown(),
  // Operator lifecycle: `active` (default) or `archived` (paused). Defaults to
  // `active` when the column is absent on a row (e.g. a test fake that predates it).
  lifecycle: ProjectLifecycleEnum.default("active"),
  // Present only on the single-project read (which selects it for the tenant
  // check); null when the column is absent/unset.
  orgId: z.string().nullable().optional(),
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
  lifecycle?: unknown;
  org_id?: unknown;
}

// The exact column list the list/read routes used (7 columns, no org_id) — the
// fakes + RLS column expectations key off this prefix.
const SELECT_PROJECT_COLUMNS = "project_id, name, repo_url, default_branch, runner_image, allocator, config";

function decodeProjectRow(raw: RawProjectRow): ProjectRow {
  return ProjectRow.parse({
    projectId: raw.project_id,
    name: raw.name,
    repoUrl: raw.repo_url,
    defaultBranch: raw.default_branch,
    runnerImage: raw.runner_image,
    allocator: raw.allocator,
    config: raw.config,
    // Absent on a fake/legacy row ⇒ the schema default ("active") applies.
    lifecycle: raw.lifecycle ?? undefined,
    orgId: raw.org_id === undefined ? undefined : ((raw.org_id ?? null) as string | null),
  });
}

export const ProjectStore = {
  /** All projects for an org, ordered by name (the project-list route). */
  async listForOrg(client: QueryClient, orgId: string, _actor: ActorRef): Promise<ProjectRow[]> {
    const result = await client.query(
      `SELECT ${SELECT_PROJECT_COLUMNS}, lifecycle
         FROM projects
        WHERE org_id = $1
        ORDER BY name`,
      [orgId],
    );
    return result.rows.map((row) => decodeProjectRow(row as RawProjectRow));
  },

  /**
   * A single project by id, selecting `org_id` too so the caller can compare it
   * against the path org (the project-read tenant check). No org filter; the
   * caller decides access. `undefined` when no row exists.
   */
  async get(client: QueryClient, projectId: string, _actor: ActorRef): Promise<ProjectRow | undefined> {
    const result = await client.query(
      `SELECT ${SELECT_PROJECT_COLUMNS}, org_id, lifecycle
         FROM projects
        WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeProjectRow(row as RawProjectRow);
  },

  /**
   * The org id for a project (the brownfield-link + project-PATCH tenant gate),
   * or `undefined` when no row exists. SQL matches the original `SELECT org_id
   * FROM projects WHERE project_id = $1`.
   */
  async getOrgId(client: QueryClient, projectId: string, _actor: ActorRef): Promise<string | null | undefined> {
    const result = await client.query("SELECT org_id FROM projects WHERE project_id = $1", [projectId]);
    const row = result.rows[0] as { org_id?: unknown } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return (row.org_id ?? null) as string | null;
  },

  /**
   * The org id + default branch for a project (the brownfield full-track guard),
   * or `undefined` when no row exists. SQL matches the original `SELECT org_id,
   * default_branch FROM projects WHERE project_id = $1`.
   */
  async getOwnership(
    client: QueryClient,
    projectId: string,
    _actor: ActorRef,
  ): Promise<{ orgId: string | null; defaultBranch: string | null } | undefined> {
    const result = await client.query("SELECT org_id, default_branch FROM projects WHERE project_id = $1", [projectId]);
    const row = result.rows[0] as { org_id?: unknown; default_branch?: unknown } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      orgId: (row.org_id ?? null) as string | null,
      defaultBranch: (row.default_branch ?? null) as string | null,
    };
  },

  /** The raw stored `config` blob for a project (the posture writer read-modify-writes it). */
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
