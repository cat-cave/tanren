// bh-14a — the read-only proof surface. There is NO public seal/mutate endpoint:
// sealing is internal, driven by the ResolutionAuthority (blocked terminal) and
// the source-sync worker (verified_closed terminal). This route only reads the
// sealed proof chain(s) for a loop and re-verifies each against the current
// evidence, so a tampered linked row surfaces here as `verification.valid=false`.
//
// Mounted at "/v1/orgs":
//   GET /v1/orgs/:orgId/projects/:projectId/issue-loops/:loopId/proof

import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { ResolutionProofStore } from "../../engine/governance/resolutionProofSealer.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface ResolutionProofRoutesOptions {
  readonly pool: pg.Pool;
  readonly store?: Pick<ResolutionProofStore, "listForLoop">;
}

type RouteContext = Context<ActorContextEnv>;

function requireActor(c: RouteContext): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

export function createResolutionProofRoutes(options: ResolutionProofRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const store = options.store ?? new ResolutionProofStore(options.pool);

  app.get("/:orgId/projects/:projectId/issue-loops/:loopId/proof", async (c) => {
    const actor = requireActor(c);
    const orgId = requireParam(c, "orgId");
    const projectId = requireParam(c, "projectId");
    const loopId = requireParam(c, "loopId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const proofs = await store.listForLoop(orgId, projectId, loopId);
    return c.json({ version: "v1" as const, orgId, projectId, loopId, proofs });
  });

  return app;
}
