// P2A-0013: spec CRUD routes scoped by org+project. Run trigger and spec
// dependency wiring delegate to `engine/workflow/projectSpec.ts`.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  createQueuedRunFromSpec,
  createSpec,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotRunnableError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface SpecRoutesOptions {
  pool: pg.Pool;
}

const SpecCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
});

const SpecPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(),
});

const RunInputSchema = z.object({
  trigger: z.enum(["cli", "dashboard", "api", "webhook"]).optional(),
  branch: z.string().min(1).optional(),
});

export function createSpecRoutes(options: SpecRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/specs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    // RLS R2 cohort-3 (specs read): the spec-list query runs through the
    // org-scoped client so it executes inside `SET LOCAL app.current_org_id =
    // <orgId>` (org validated against the actor above). Inert in R1 — no
    // policies read the GUC — and behavior-identical to the pool path.
    const rows = await runWithOrgScope(options.pool, orgId, (client) =>
      client.query<SpecRow>(
        `SELECT spec_id, project_id, title, description, acceptance_criteria, depends_on, status
           FROM specs
          WHERE project_id = $1
          ORDER BY title`,
        [projectId],
      ),
    );
    return c.json({ specs: rows.rows.map(toSpecContract) });
  });

  app.post("/:orgId/projects/:projectId/specs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = SpecCreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
    }
    try {
      const spec = await createSpec(options.pool, { projectId, ...parsed.data }, { ...actor, orgId });
      return c.json(spec, 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/:orgId/projects/:projectId/specs/:specId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    // RLS R2 cohort-3 (specs read): the spec-detail query runs through the
    // org-scoped client (inert in R1; same row as the pool path).
    const result = await runWithOrgScope(options.pool, orgId, (client) =>
      client.query<SpecRow>(
        `SELECT spec_id, project_id, title, description, acceptance_criteria, depends_on, status
           FROM specs WHERE spec_id = $1`,
        [specId],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) {
      return c.json({ error: "spec_not_found" }, 404);
    }
    return c.json(toSpecContract(row));
  });

  app.patch("/:orgId/projects/:projectId/specs/:specId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = SpecPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec_patch", issues: parsed.error.issues }, 400);
    }
    const data = parsed.data;
    const fragments: string[] = [];
    const params: unknown[] = [];
    if (data.title !== undefined) {
      params.push(data.title);
      fragments.push(`title = $${params.length}`);
    }
    if (data.description !== undefined) {
      params.push(data.description);
      fragments.push(`description = $${params.length}`);
    }
    if (data.acceptanceCriteria !== undefined) {
      params.push(JSON.stringify(data.acceptanceCriteria));
      fragments.push(`acceptance_criteria = $${params.length}::jsonb`);
    }
    if (fragments.length === 0) {
      return c.json({ error: "invalid_spec_patch", message: "no updatable fields supplied" }, 400);
    }
    params.push(specId);
    // RLS R2 cohort-3 (specs write): the spec PATCH runs through the org-scoped
    // client so the UPDATE executes inside `SET LOCAL app.current_org_id =
    // <orgId>` (inert in R1; same committed row as the pool path).
    const updated = await runWithOrgScope(options.pool, orgId, (client) =>
      client.query(
        `UPDATE specs SET ${fragments.join(", ")} WHERE spec_id = $${params.length} RETURNING spec_id`,
        params,
      ),
    );
    if (updated.rowCount === 0) {
      return c.json({ error: "spec_not_found" }, 404);
    }
    return c.json({ specId, patched: true });
  });

  app.post("/:orgId/projects/:projectId/specs/:specId/runs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = RunInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_run", issues: parsed.error.issues }, 400);
    }
    try {
      const run = await createQueuedRunFromSpec(options.pool, { specId, ...parsed.data }, { ...actor, orgId });
      return c.json(run, 201);
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecDependenciesBlockedError) {
        return c.json({ error: "spec_dependencies_blocked", message: error.message }, 409);
      }
      if (error instanceof SpecNotRunnableError) {
        return c.json({ error: "spec_not_runnable", message: error.message }, 409);
      }
      throw error;
    }
  });

  return app;
}

function toSpecContract(row: SpecRow) {
  return {
    specId: row.spec_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: parseStringArray(row.acceptance_criteria),
    dependsOn: parseStringArray(row.depends_on),
    status: row.status,
  };
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
}
