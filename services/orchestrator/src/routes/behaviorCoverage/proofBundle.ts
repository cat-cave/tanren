// rv-24 — the read-only exportable-proof-bundle surface. There is NO seal/mutate
// endpoint: a bundle is assembled READ-ONLY from the real persisted acceptance evidence
// (run + verification-environment binding + append-only verdicts + bh-14a resolution
// proofs) and chained into a tamper-evident, offline-verifiable document. The exported
// JSON is what `tanren proof verify` validates with no DB access.
//
// Mounted at "/v1/orgs":
//   GET /v1/orgs/:orgId/projects/:projectId/verification-runs/:runId/proof-bundle

import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { ProofBundleStore } from "../../engine/verification/acceptance/proofBundleStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface ProofBundleRoutesOptions {
  readonly pool: pg.Pool;
  readonly store?: Pick<ProofBundleStore, "exportForRun">;
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

export function createProofBundleRoutes(options: ProofBundleRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const store = options.store ?? new ProofBundleStore(options.pool);

  app.get("/:orgId/projects/:projectId/verification-runs/:runId/proof-bundle", async (c) => {
    const actor = requireActor(c);
    const orgId = requireParam(c, "orgId");
    const projectId = requireParam(c, "projectId");
    const runId = requireParam(c, "runId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const bundle = await store.exportForRun({ orgId, projectId, runId });
    if (bundle === undefined) return c.json({ error: "verification_run_not_found" }, 404);
    return c.json(bundle);
  });

  return app;
}
