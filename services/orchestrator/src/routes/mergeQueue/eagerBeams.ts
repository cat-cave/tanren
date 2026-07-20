// mq-8 read-only EAGER beam projection. Rows remain advisory preparation; this
// route deliberately exposes no merge/land action and fails closed on corrupt node data.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const membersSchema = z.array(
  z
    .object({ specId: z.string().min(1), runId: z.string().min(1), branch: z.string().min(1), headSha: fullSha })
    .strict(),
);
const beamStateSchema = z.enum(["building", "ready", "stale", "held"]);
const nodeStatusSchema = z.enum(["building", "ready", "landed", "stale"]);

interface EagerBeamRow {
  id: string;
  frontier_run_id: string;
  frontier_spec_id: string;
  plan_digest: string | null;
  integration_node_id: string | null;
  rank: number;
  generation: number;
  state: string;
  stale_reason: string | null;
  updated_at: Date;
  base_sha: string | null;
  members: unknown;
  node_status: string | null;
  proof_root: string | null;
}

function actor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

export function createMergeQueueEagerBeamRoutes(options: { pool: pg.Pool }) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/merge-queue/eager-beams", async (c) => {
    const requestingActor = actor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(requestingActor, orgId)) return c.json({ error: "eager_beams_not_found" }, 404);
    const projectId = c.req.param("projectId");
    const beams = await runWithOrgScope(options.pool, orgId, async (client) => {
      try {
        const project = await assertProjectAccess(client, projectId, requestingActor);
        if (project.orgId !== orgId) return null;
      } catch (error) {
        if (error instanceof ToolAccessDeniedError) return null;
        throw error;
      }
      const result = await client.query<EagerBeamRow>(
        `SELECT b.id, b.frontier_run_id, b.frontier_spec_id, b.plan_digest, b.integration_node_id,
                b.rank, b.generation, b.state, b.stale_reason, b.updated_at,
                n.base_sha, n.members, n.status AS node_status, n.proof_root
           FROM merge_eager_beams b
           LEFT JOIN integration_nodes n ON n.org_id = b.org_id AND n.node_id = b.integration_node_id
          WHERE b.project_id = $1
          ORDER BY b.rank ASC, b.updated_at DESC, b.id ASC`,
        [projectId],
      );
      return result.rows.map(projectRow);
    });
    if (beams === null) return c.json({ error: "eager_beams_not_found" }, 404);
    return c.json({ beams });
  });
  return app;
}

function projectRow(row: EagerBeamRow) {
  const state = beamStateSchema.safeParse(row.state);
  if (!state.success) throw new Error("merge_eager_beams.state is corrupt");
  const nodeStatus = row.node_status === null ? undefined : nodeStatusSchema.safeParse(row.node_status);
  if (nodeStatus !== undefined && !nodeStatus.success)
    throw new Error("merge_eager_beams integration node status is corrupt");
  const baseSha = row.base_sha === null ? undefined : fullSha.safeParse(row.base_sha);
  const members = row.members === null || row.members === undefined ? undefined : membersSchema.safeParse(row.members);
  const exactEvidence =
    row.integration_node_id !== null &&
    baseSha !== undefined &&
    baseSha.success &&
    members !== undefined &&
    members.success &&
    nodeStatus !== undefined &&
    nodeStatus.success;
  return {
    id: row.id,
    frontierRunId: row.frontier_run_id,
    frontierSpecId: row.frontier_spec_id,
    planDigest: row.plan_digest,
    integrationNodeId: row.integration_node_id,
    rank: row.rank,
    generation: row.generation,
    state: state.data,
    staleReason: row.stale_reason,
    updatedAt: row.updated_at.toISOString(),
    evidenceState: exactEvidence ? "exact" : row.integration_node_id === null ? "not_built" : "unavailable",
    ...(exactEvidence
      ? {
          baseSha: baseSha.data,
          members: members.data,
          nodeStatus: nodeStatus.data,
          proofRoot: row.proof_root,
        }
      : {}),
  };
}
