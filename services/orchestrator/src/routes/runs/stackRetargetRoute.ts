// gv-4: GET .../runs/:runId/stack-retarget — callable projection of the
// transitive stack-retarget authority. Exercises the same
// `resolveSpeculativeState` + `resolveStackRetarget` production path the merge
// stage uses (no parallel resolver). Extracted so routes/runs/index.ts stays
// under its line cap.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import {
  resolveSpeculativeState,
  resolveStackRetarget,
} from "../../engine/workflow/reviewMerge/speculativeStackRetarget.js";
import { StackRetargetView } from "./stackRetargetContract.js";

export function registerStackRetargetRoute(app: Hono<ActorContextEnv>, options: { pool: pg.Pool }): void {
  app.get("/:orgId/projects/:projectId/runs/:runId/stack-retarget", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const view = await runWithOrgScope(options.pool, orgId, async (client) => {
      const runRow = await client.query<{
        run_id: string;
        project_id: string;
        org_id: string;
        default_branch: string | null;
      }>(
        `SELECT r.run_id, r.project_id, r.org_id, p.default_branch
           FROM runs r
           JOIN projects p ON p.project_id = r.project_id
          WHERE r.run_id = $1
            AND r.org_id = $2
            AND r.project_id = $3`,
        [runId, orgId, projectId],
      );
      const row = runRow.rows[0];
      if (row === undefined) {
        return undefined;
      }
      const defaultBranch = row.default_branch !== null && row.default_branch !== "" ? row.default_branch : "main";
      // Production construction path: same resolveSpeculativeState the merge stage calls.
      const speculative = await resolveSpeculativeState(client, runId);
      if (speculative === undefined) {
        return StackRetargetView.parse({
          missionNodeId: "gv-4",
          runId,
          projectId,
          orgId,
          speculative: false,
          defaultBranch,
          members: [],
          mergedSpecIds: [],
          unmergedAncestors: [],
          toBase: defaultBranch,
          remainingStack: [],
        });
      }
      const { toBase, remainingStack } = resolveStackRetarget(
        speculative.ancestorStack,
        speculative.mergedSpecIds,
        defaultBranch,
      );
      const mergedList = [...speculative.mergedSpecIds];
      return StackRetargetView.parse({
        missionNodeId: "gv-4",
        runId,
        projectId,
        orgId,
        speculative: true,
        defaultBranch,
        members: speculative.ancestorStack.map((member) => ({
          ...member,
          merged: speculative.mergedSpecIds.has(member.specId),
        })),
        mergedSpecIds: mergedList,
        unmergedAncestors: speculative.unmergedAncestors,
        toBase,
        remainingStack: [...remainingStack],
      });
    });

    if (view === undefined) {
      return c.json({ error: "run_not_found" }, 404);
    }
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
