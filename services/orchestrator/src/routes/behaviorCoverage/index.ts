import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { BehaviorRevisionId } from "../../engine/contracts/behaviorRevision.js";
import type { ActorRef } from "../../engine/state/actor.js";
import {
  BehaviorCoverageEdgesStore,
  BehaviorCoverageSubjectNotFoundError,
  type BehaviorCoverageEdgesRepository,
} from "../../engine/repositories/behaviorCoverageEdges.js";
import {
  AFFECTED_TARGET_KINDS,
  COVERAGE_EDGE_KINDS,
  selectAffectedBehaviorRevisions,
} from "../../engine/runtimeVerification/affectedSelection.js";
import type { AffectedSelectionFactWriter } from "../../engine/runtimeVerification/affectedSelectionFacts.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface BehaviorCoverageRoutesOptions {
  readonly pool: pg.Pool;
  readonly facts: AffectedSelectionFactWriter;
  readonly repository?: BehaviorCoverageEdgesRepository;
}

const EdgeBodySchema = z
  .object({
    behaviorRevisionId: z.string().min(1).max(200),
    edgeKind: z.enum(COVERAGE_EDGE_KINDS),
    targetRef: z.string().min(1).max(2_000),
  })
  .strict();

const AffectedSelectionBodySchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            kind: z.enum(AFFECTED_TARGET_KINDS),
            targetRef: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

type RouteContext = Context<ActorContextEnv>;

async function authorizeProject(
  c: RouteContext,
  pool: pg.Pool,
): Promise<{ actor: ActorContext; orgId: string; projectId: string } | Response> {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  if (!actorCanAccessOrg(actor, orgId)) {
    return c.json({ error: "org_access_denied" }, 403);
  }
  try {
    const project = await assertProjectAccess(pool, projectId, actor);
    if (project.orgId !== orgId) {
      return c.json({ error: "project_access_denied" }, 403);
    }
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return c.json({ error: "project_access_denied" }, 403);
    }
    throw error;
  }
  return { actor, orgId, projectId };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export function createBehaviorCoverageRoutes(options: BehaviorCoverageRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const repository = options.repository ?? BehaviorCoverageEdgesStore;

  app.get("/:orgId/projects/:projectId/behavior-coverage", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    try {
      const snapshot = await repository.readSnapshot(
        options.pool,
        { orgId: authorized.orgId, projectId: authorized.projectId },
        actorRef(authorized.actor),
      );
      return c.json({
        version: "v1" as const,
        orgId: authorized.orgId,
        projectId: authorized.projectId,
        behaviors: snapshot.behaviors,
        uncoveredBehaviorRevisionIds: snapshot.behaviors
          .filter((behavior) => behavior.edges.length === 0)
          .map((behavior) => behavior.behaviorRevisionId),
      });
    } catch {
      return c.json({ error: "behavior_coverage_unavailable" }, 503);
    }
  });

  app.post("/:orgId/projects/:projectId/behavior-coverage/edges", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    if (!actorIsOrgAdmin(authorized.actor, authorized.orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = EdgeBodySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_behavior_coverage_edge", issues: parsed.error.issues }, 400);
    }
    try {
      const edge = await repository.record(
        options.pool,
        { orgId: authorized.orgId, projectId: authorized.projectId },
        {
          behaviorRevisionId: parsed.data.behaviorRevisionId as BehaviorRevisionId,
          kind: parsed.data.edgeKind,
          targetRef: parsed.data.targetRef,
        },
        actorRef(authorized.actor),
      );
      return c.json({ edge }, 201);
    } catch (error) {
      if (error instanceof BehaviorCoverageSubjectNotFoundError) {
        return c.json({ error: "behavior_coverage_subject_not_found" }, 404);
      }
      return c.json({ error: "behavior_coverage_write_failed" }, 503);
    }
  });

  app.post("/:orgId/projects/:projectId/behavior-coverage/affected-selection", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    const parsed = AffectedSelectionBodySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_affected_selection", issues: parsed.error.issues }, 400);
    }
    try {
      const snapshot = await repository.readSnapshot(
        options.pool,
        { orgId: authorized.orgId, projectId: authorized.projectId },
        actorRef(authorized.actor),
      );
      const selection = selectAffectedBehaviorRevisions({
        analysisId: `coverage_selection_${randomUUID()}`,
        snapshot,
        changedTargets: parsed.data.targets,
      });
      await options.facts.record(selection, {});
      return c.json({ selection }, 201);
    } catch {
      return c.json({ error: "affected_selection_unavailable" }, 503);
    }
  });

  return app;
}

function actorRef(actor: ActorContext): ActorRef {
  return { kind: "operator", id: actor.userId };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") {
    throw new Error(`route parameter ${name} missing`);
  }
  return value;
}
