// P3-0014 spec-discovery HTTP routes.
//
//   POST /:orgId/projects/:projectId/discovery/classify
//     Body: a DiscoveryInsight. Runs the discovery engine's classification
//     (over the injectable answerer) and returns proposed specs + DAG-placement
//     options + impact deltas. Persists nothing.
//
//   POST /:orgId/projects/:projectId/discovery/accept
//     Body: { insight, proposals, placementKind, placementLabel }. Creates the
//     accepted specs through the existing P2A-0013 path and stamps discovery
//     provenance onto each spec's metadata. Returns the created spec-ids.
//
// The answerer is injectable (`answererFactory`) — production can wire a
// provider-backed discovery answerer; tests inject a fake. When omitted the
// engine falls back to its deterministic grounded answerer, so the endpoint is
// always live. Mounted on the same `/orgs` base as the other product routes.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  acceptProposals,
  classifyInsight,
  DiscoveryInsight,
  PlacementKind,
  ProposedSpec,
  type DiscoveryAnswerer,
} from "../../engine/forge/discovery/index.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface DiscoveryRoutesOptions {
  pool: pg.Pool;
  // Injectable classification answerer (provider wrap or a test fake). Defaults
  // to the engine's deterministic grounded answerer when omitted.
  answererFactory?: () => DiscoveryAnswerer;
}

const ClassifyBody = DiscoveryInsight;

const AcceptBody = z
  .object({
    insight: DiscoveryInsight,
    proposals: z.array(ProposedSpec).min(1),
    placementKind: PlacementKind,
    placementLabel: z.string().min(1).max(120),
  })
  .strict();

export function createDiscoveryRoutes(options: DiscoveryRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const answerer = options.answererFactory?.();

  app.post("/:orgId/projects/:projectId/discovery/classify", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ClassifyBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_insight", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await classifyInsight(
        { pool: options.pool, ...(answerer === undefined ? {} : { answerer }) },
        { projectId: c.req.param("projectId"), insight: parsed.data, actor },
      );
      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: "discovery_classify_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/projects/:projectId/discovery/accept", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = AcceptBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_accept", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await acceptProposals(
        { pool: options.pool, ...(answerer === undefined ? {} : { answerer }) },
        {
          projectId: c.req.param("projectId"),
          insight: parsed.data.insight,
          proposals: parsed.data.proposals,
          placementKind: parsed.data.placementKind,
          placementLabel: parsed.data.placementLabel,
          actor: { ...actor, orgId },
        },
      );
      return c.json(
        {
          accepted: result.accepted.map((entry) => ({
            proposalId: entry.proposalId,
            spec: entry.spec,
          })),
        },
        201,
      );
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
      return c.json({ error: "discovery_accept_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
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
