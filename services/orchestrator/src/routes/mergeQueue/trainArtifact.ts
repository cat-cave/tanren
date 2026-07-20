// mq-15 read-only merge-train projection routes. Two org-scoped GETs over the durable
// `merge_train_artifacts` table — a list of the project's sealed trains and one exact
// land-group artifact (its strict re-validated manifest, or its canonical CAS bytes).
// Both run through `runWithOrgScope` + `assertProjectAccess`; a cross-org / cross-project
// caller sees ZERO rows (RLS) and a 404 — never another org's delivery. These routes
// re-validate the persisted manifest (`validateMergeTrainArtifact`) before returning it,
// so a corrupted row fails closed rather than serving a mismatched artifact as green.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  MergeTrainArtifactInvalidError,
  encodeMergeTrainArtifactBytes,
  MERGE_TRAIN_ARTIFACT_MEDIA_TYPE,
} from "../../engine/contracts/mergeTrainArtifact.js";
import { PgMergeTrainArtifactStore } from "../../engine/postMerge/mergeTrainArtifactStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface TrainArtifactRoutesOptions {
  pool: pg.Pool;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : undefined;
}

/** Run `read` under org scope only after project access is confirmed; null ⇒ 404. */
async function withProject<T>(input: {
  pool: pg.Pool;
  actor: ActorContext;
  orgId: string;
  projectId: string;
  read: (client: pg.PoolClient) => Promise<T>;
}): Promise<T | null> {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, input.projectId, input.actor);
      if (project.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }
    return input.read(client);
  });
}

export function createMergeTrainArtifactRoutes(options: TrainArtifactRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/merge-queue/train", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_train_not_found" }, 404);
    const limit = parseLimit(c.req.query("limit"));
    if (limit === undefined) return c.json({ error: "invalid_limit", min: 1, max: MAX_LIMIT }, 400);
    const artifacts = await withProject({
      pool: options.pool,
      actor,
      orgId,
      projectId: c.req.param("projectId"),
      read: (client) => PgMergeTrainArtifactStore.list(client, orgId, c.req.param("projectId"), limit),
    });
    if (artifacts === null) return c.json({ error: "merge_train_not_found" }, 404);
    return c.json({ artifacts });
  });

  app.get("/:orgId/projects/:projectId/merge-queue/land-groups/:groupId/artifact", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "merge_train_artifact_not_found" }, 404);
    const projectId = c.req.param("projectId");
    const groupId = c.req.param("groupId");
    let artifact;
    try {
      artifact = await withProject({
        pool: options.pool,
        actor,
        orgId,
        projectId,
        read: (client) => PgMergeTrainArtifactStore.getByLandGroup(client, orgId, projectId, groupId),
      });
    } catch (error) {
      // A corrupted/mismatched persisted manifest fails closed as unavailable.
      if (error instanceof MergeTrainArtifactInvalidError)
        return c.json({ error: "merge_train_artifact_not_found" }, 404);
      throw error;
    }
    if (artifact === null || artifact === undefined) return c.json({ error: "merge_train_artifact_not_found" }, 404);
    if (c.req.query("format") === "bytes") {
      c.header("content-type", MERGE_TRAIN_ARTIFACT_MEDIA_TYPE);
      return c.body(Buffer.from(encodeMergeTrainArtifactBytes(artifact)));
    }
    return c.json({ artifact });
  });

  return app;
}
