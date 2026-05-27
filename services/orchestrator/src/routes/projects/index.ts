// P2A-0013: project CRUD routes scoped under an org. Project create is the
// non-brownfield path (caller supplies repoUrl + name). The brownfield link
// endpoint lives in routes/brownfield/ and reads target-repo files via the
// org's GitHub App credentials; it never writes.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateProjectConfig } from "../../engine/config/projectConfig.js";
import {
  createProject,
  ProjectAccessDeniedError,
  ProjectNotFoundError
} from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface ProjectRoutesOptions {
  pool: pg.Pool;
}

const ProjectCreateSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  runnerImage: z.string().min(1).optional(),
  allocator: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const ProjectPatchSchema = z.object({
  config: z.record(z.string(), z.unknown())
});

export function createProjectRoutes(options: ProjectRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const rows = await options.pool.query<ProjectRow>(
      `SELECT project_id, name, repo_url, default_branch, runner_image, allocator, config
         FROM projects
        WHERE org_id = $1
        ORDER BY name`,
      [orgId]
    );
    return c.json({ projects: rows.rows.map(toProjectContract) });
  });

  app.post("/:orgId/projects", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ProjectCreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_project", issues: parsed.error.issues }, 400);
    }
    const scopedActor: ActorContext = { ...actor, orgId };
    const project = await createProject(options.pool, parsed.data, scopedActor);
    return c.json(project, 201);
  });

  app.get("/:orgId/projects/:projectId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const project = await readProject(options.pool, orgId, projectId, actor);
      return c.json(project);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      throw error;
    }
  });

  app.patch("/:orgId/projects/:projectId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ProjectPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_project_config", issues: parsed.error.issues }, 400);
    }
    let nextConfig;
    try {
      nextConfig = migrateProjectConfig(parsed.data.config);
    } catch (error) {
      return c.json({ error: "invalid_project_config", message: messageOf(error) }, 400);
    }
    const existing = await options.pool.query<{ org_id: string | null }>(
      "SELECT org_id FROM projects WHERE project_id = $1",
      [projectId]
    );
    const projectOrg = existing.rows[0]?.org_id ?? null;
    if (existing.rowCount === 0 || (projectOrg !== null && projectOrg !== orgId)) {
      return c.json({ error: "project_not_found" }, 404);
    }
    await options.pool.query(
      "UPDATE projects SET config = $1::jsonb WHERE project_id = $2",
      [JSON.stringify(nextConfig), projectId]
    );
    return c.json({ projectId, config: nextConfig });
  });

  return app;
}

export async function readProject(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  _actor: ActorContext
) {
  const result = await pool.query<ProjectRow & { org_id: string | null }>(
    `SELECT project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id
       FROM projects
      WHERE project_id = $1`,
    [projectId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ProjectNotFoundError(projectId);
  }
  if (row.org_id !== null && row.org_id !== orgId) {
    throw new ProjectAccessDeniedError(projectId);
  }
  return toProjectContract(row);
}

function toProjectContract(row: ProjectRow) {
  return {
    projectId: row.project_id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    runnerImage: row.runner_image,
    allocator: row.allocator,
    config: migrateProjectConfig(row.config)
  };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProjectRow {
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  allocator: string;
  config: unknown;
}
