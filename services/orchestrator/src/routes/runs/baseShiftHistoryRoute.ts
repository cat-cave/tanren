// gv-17: GET .../runs/:runId/base-shift-history — before/after member vectors
// and invalidation causes for every durable restack on a dependent run.

import type { Context, Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { PgBaseShiftOperationStore } from "../../engine/dag/baseShiftOperationsPg.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const MemberSchema = z
  .object({
    specId: z.string().min(1),
    runId: z.string().min(1),
    branch: z.string().min(1),
    headSha: z.string().min(1),
  })
  .strict();

const BaseShiftHistoryView = z
  .object({
    missionNodeId: z.literal("gv-17"),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    orgId: z.string().min(1),
    operations: z.array(
      z
        .object({
          opId: z.string().min(1),
          nodeId: z.string().min(1).optional(),
          ancestorSpecId: z.string().min(1).optional(),
          fromBaseSha: z.string().min(1),
          toBaseSha: z.string().min(1),
          fromMemberKey: z.string().min(1),
          toMemberKey: z.string().min(1),
          fromMembers: z.array(MemberSchema),
          toMembers: z.array(MemberSchema),
          decision: z.enum(["rebased_clean", "rebased_resolved", "replanned", "held"]),
          invalidationCause: z.enum([
            "ancestor_landed",
            "base_moved",
            "member_head_moved",
            "stack_restack",
            "policy_changed",
            "proof_stale",
          ]),
          createdAt: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export function registerBaseShiftHistoryRoute(app: Hono<ActorContextEnv>, options: { pool: pg.Pool }): void {
  app.get("/:orgId/projects/:projectId/runs/:runId/base-shift-history", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const store = new PgBaseShiftOperationStore(options.pool);
    const operations = await store.listForDependentRun(orgId, runId);
    const view = BaseShiftHistoryView.parse({
      missionNodeId: "gv-17",
      runId,
      projectId,
      orgId,
      operations: operations.map((op) => ({
        opId: op.opId,
        ...(op.nodeId !== undefined && { nodeId: op.nodeId }),
        ...(op.ancestorSpecId !== undefined && { ancestorSpecId: op.ancestorSpecId }),
        fromBaseSha: op.fromBaseSha,
        toBaseSha: op.toBaseSha,
        fromMemberKey: op.fromMemberKey,
        toMemberKey: op.toMemberKey,
        fromMembers: op.fromMembers,
        toMembers: op.toMembers,
        decision: op.decision,
        invalidationCause: op.invalidationCause,
        createdAt: op.createdAt.toISOString(),
      })),
    });
    return c.json(view);
  });
}

async function gateProjectAccess(
  pool: pg.Pool,
  projectId: string,
  actor: ActorContext,
  c: Context,
): Promise<Response | undefined> {
  try {
    await assertProjectAccess(pool, projectId, actor);
    return undefined;
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return c.json({ error: "project_access_denied", message: error.message }, 403);
    }
    throw error;
  }
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
