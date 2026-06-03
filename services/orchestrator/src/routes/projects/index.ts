// P2A-0013: project CRUD routes scoped under an org. Project create is the
// non-brownfield path (caller supplies repoUrl + name). The brownfield link
// endpoint lives in routes/brownfield/ and reads target-repo files via the
// org's GitHub App credentials; it never writes.
//
// GREENFIELD: the `/projects/greenfield` create path lets an end user start a
// greenfield project WITHOUT bringing a repo — Tanren creates a brand-new repo
// under the org's GitHub App grant (the `VcsProvider.createRepository` seam) and
// binds the project to the real new repoUrl. The repo-create itself lives in
// `greenfield.ts` so this file stays under the per-file line cap.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { migrateProjectConfig } from "../../engine/config/projectConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { VcsProvider } from "../../engine/contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { ProjectStore, type ProjectRow as RepoProjectRow } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import { createProject, ProjectAccessDeniedError, ProjectNotFoundError } from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/index.js";
import { BudgetPutSchema, handleBudgetGet, handleBudgetPut } from "./budget.js";
import { GovernancePutSchema, handleGovernanceGet, handleGovernancePut } from "./governance.js";
import { GreenfieldCreateSchema, handleGreenfieldCreate } from "./greenfield.js";

// P-APP-ENV-1: re-exported here so the feature-route mounter pulls both the
// project CRUD routes and the app-env CI-secret propagation route from one import
// site (keeping the mounter under its per-file dependency cap).
export { createAppEnvCiRoutes } from "./appEnvCi.js";

interface ProjectRoutesOptions {
  pool: pg.Pool;
  // GREENFIELD: the deps the `/projects/greenfield` create path needs to mint the
  // org's GitHub App token + create the repo through the VcsProvider seam.
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
}

const ProjectCreateSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  runnerImage: z.string().min(1).optional(),
  allocator: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const ProjectPatchSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

export function createProjectRoutes(options: ProjectRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const rows = await ProjectStore.listForOrg(options.pool, orgId, systemActor);
    return c.json({ projects: rows.map((row) => toProjectContract(row)) });
  });

  app.post("/:orgId/projects", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ProjectCreateSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_project", issues: parsed.error.issues }, 400);
    }
    // Validate a supplied config up-front: it must be an explicit `version: 1`
    // blob (an unversioned/malformed config fails hard — no migration shim).
    // Mirrors the PATCH route's parse-then-400 contract.
    if (parsed.data.config !== undefined) {
      try {
        migrateProjectConfig(parsed.data.config);
      } catch (error) {
        return c.json({ error: "invalid_project_config", message: messageOf(error) }, 400);
      }
    }
    const scopedActor: ActorContext = { ...actor, orgId };
    const project = await createProject(options.pool, parsed.data, scopedActor);
    return c.json(project, 201);
  });

  // GREENFIELD: create a project with NO repoUrl — Tanren creates a brand-new
  // GitHub repo under the org's App grant (`owner`), auto-inits it (immediately
  // cloneable), then binds the project to the real new repoUrl. The repo-create +
  // token resolution live in `greenfield.ts`; this handler owns the org guard +
  // the org-scoped project persist.
  app.post("/:orgId/projects/greenfield", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = GreenfieldCreateSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_greenfield_project", issues: parsed.error.issues }, 400);
    }
    return handleGreenfieldCreate(c, {
      pool: options.pool,
      secrets: options.secrets,
      vcsProvider: options.vcsProvider,
      githubAppMinter: options.githubAppMinter,
      orgId,
      actor,
      input: parsed.data,
    });
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
    const parsed = ProjectPatchSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_project_config", issues: parsed.error.issues }, 400);
    }
    let nextConfig;
    try {
      nextConfig = migrateProjectConfig(parsed.data.config);
    } catch (error) {
      return c.json({ error: "invalid_project_config", message: messageOf(error) }, 400);
    }
    const ownership = await ProjectStore.getOwnership(options.pool, projectId, systemActor);
    if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
      return c.json({ error: "project_not_found" }, 404);
    }
    await ProjectStore.updateConfig(options.pool, projectId, nextConfig, systemActor);
    return c.json({ projectId, config: nextConfig });
  });

  // The dedicated dollar-budget surface (autonomy-engine.md §3 proof 6): a
  // discoverable read + update for the budget ceiling the DagWalker enforces, so an
  // operator never hand-crafts a full config PATCH to change it. Both org-scoped.
  app.get("/:orgId/projects/:projectId/budget", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    return handleBudgetGet(c, options.pool, orgId, c.req.param("projectId"));
  });

  app.put("/:orgId/projects/:projectId/budget", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = BudgetPutSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_budget", issues: parsed.error.issues }, 400);
    }
    return handleBudgetPut(c, options.pool, orgId, c.req.param("projectId"), parsed.data);
  });

  // The dedicated GOVERNANCE surface (apex.md "missing endpoint → add it"): a
  // discoverable read + update for the three settings that decide whether the
  // autonomous DagWalker can advance a project (reviewPolicy / mergeIntegration /
  // governancePosture) — the supported way to flip an existing project to
  // autonomous, so an operator never hand-crafts a full-config PATCH. The READ is
  // org-member; the MUTATION is org-admin (it changes the autonomy posture).
  app.get("/:orgId/projects/:projectId/governance", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    return handleGovernanceGet(c, options.pool, orgId, c.req.param("projectId"));
  });

  app.put("/:orgId/projects/:projectId/governance", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = GovernancePutSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_governance", issues: parsed.error.issues }, 400);
    }
    return handleGovernancePut(c, options.pool, orgId, c.req.param("projectId"), parsed.data);
  });

  return app;
}

export async function readProject(pool: pg.Pool, orgId: string, projectId: string, _actor: ActorContext) {
  const row = await ProjectStore.get(pool, projectId, systemActor);
  if (row === undefined) {
    throw new ProjectNotFoundError(projectId);
  }
  if (row.orgId !== null && row.orgId !== orgId) {
    throw new ProjectAccessDeniedError(projectId);
  }
  return toProjectContract(row);
}

function toProjectContract(row: RepoProjectRow) {
  return {
    projectId: row.projectId,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    runnerImage: row.runnerImage,
    allocator: row.allocator,
    config: migrateProjectConfig(row.config),
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
