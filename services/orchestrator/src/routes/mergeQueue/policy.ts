// QueuePolicyV1 HTTP surface. Every mutation authorizes and parses before the
// controller opens a persistence transaction, so invalid input cannot orphan rows.
import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { ZodError } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  QueuePolicyControlStore,
  QueuePolicyRevisionConflictError,
} from "../../engine/merge/queuePolicyControlStore.js";
import { QueuePolicyController } from "../../engine/merge/queuePolicyController.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

function actor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

async function authorize(
  pool: pg.Pool,
  actorContext: ActorContext,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  if (!actorCanAccessOrg(actorContext, orgId)) return false;
  return runWithOrgScope(pool, orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, projectId, actorContext);
      return project.orgId === orgId;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return false;
      throw error;
    }
  });
}

function expectedVersion(header: string | undefined): number | undefined {
  if (header === undefined) throw new QueuePolicyPreconditionError();
  const raw = header.trim();
  if (raw === "*") return undefined;
  const match = /^"([1-9][0-9]*)"$/u.exec(raw);
  if (match?.[1] === undefined) throw new QueuePolicyPreconditionError();
  return Number(match[1]);
}

export function createQueuePolicyRoutes(options: { pool: pg.Pool }) {
  const app = new Hono<ActorContextEnv>();
  const controller = new QueuePolicyController(options.pool);
  const controls = new QueuePolicyControlStore(options.pool);
  const path = "/:orgId/projects/:projectId/merge-queue";

  app.get(`${path}/policy`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_policy_not_found" }, 404);
    const policy = await controls.getPolicy({ orgId, projectId });
    if (policy === null) return c.json({ error: "merge_queue_policy_not_found" }, 404);
    c.header("ETag", `"${policy.version}"`);
    return c.json(policy);
  });

  app.put(`${path}/policy`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_policy_not_found" }, 404);
    try {
      const saved = await controls.putPolicy({
        orgId,
        projectId,
        body: await c.req.json(),
        expectedVersion: expectedVersion(c.req.header("if-match")),
      });
      c.header("ETag", `"${saved.version}"`);
      return c.json(saved, 201);
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.post(`${path}/policy/validate`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_policy_not_found" }, 404);
    try {
      const checked = controls.validatePolicy(await c.req.json());
      return c.json({
        valid: true,
        compiledHash: checked.compiledHash,
        routeNames: checked.policy.routes.map((route) => route.name),
      });
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.post(`${path}/commands`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const requestingActor = actor(c);
    if (!(await authorize(options.pool, requestingActor, orgId, projectId)))
      return c.json({ error: "merge_queue_command_not_found" }, 404);
    try {
      const result = await controller.apply({
        kind: "command",
        orgId,
        projectId,
        actorId: requestingActor.userId,
        command: await c.req.json(),
      });
      return c.json({ result });
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.get(`${path}/windows`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_window_not_found" }, 404);
    return c.json({ windows: await controls.listWindows({ orgId, projectId }) });
  });

  app.post(`${path}/windows`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_window_not_found" }, 404);
    try {
      return c.json(await controls.addWindow({ orgId, projectId, window: await c.req.json() }), 201);
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.delete(`${path}/windows/:windowId`, async (c) => {
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!(await authorize(options.pool, actor(c), orgId, projectId)))
      return c.json({ error: "merge_queue_window_not_found" }, 404);
    const deleted = await controls.deleteWindow({ orgId, projectId, windowId: c.req.param("windowId") });
    return deleted ? c.json({ deleted: true }) : c.json({ error: "merge_queue_window_not_found" }, 404);
  });
  return app;
}

class QueuePolicyPreconditionError extends Error {}

function mutationError(c: { json: (value: unknown, status?: 400 | 409 | 428) => Response }, error: unknown) {
  if (error instanceof QueuePolicyPreconditionError) return c.json({ error: "if_match_required" }, 428);
  if (error instanceof QueuePolicyRevisionConflictError)
    return c.json({ error: "queue_policy_revision_conflict" }, 409);
  if (error instanceof ZodError) return c.json({ error: "queue_policy_invalid", issues: error.issues }, 400);
  throw error;
}
