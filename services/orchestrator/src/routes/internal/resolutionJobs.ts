import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const claimSchema = z.object({
  orgId: z.string().min(1),
  leaseOwner: z.string().min(1),
  leaseMs: z.number().int().positive().optional(),
});

const heartbeatSchema = claimSchema.extend({
  orgId: z.string().min(1),
});

export interface ResolutionJobRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  readonly store?: ResolutionJobStore;
}

function trusted(verifier: MtlsPeerVerifier, c: Context): boolean {
  return verifyInternalPeer(verifier, c);
}

/** mTLS-only operational claim and heartbeat surface for the durable resolution queue. */
export function createInternalResolutionJobRoutes(deps: ResolutionJobRouteDeps): Hono {
  const store = deps.store ?? new ResolutionJobStore(deps.pool);
  const app = new Hono();

  app.post("/internal/resolution-jobs/claim", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_resolution_job_claim", issues: parsed.error.issues }, 400);
    const job = await store.claimNext(parsed.data);
    return c.json({ job: job ?? null });
  });

  app.post("/internal/resolution-jobs/:id/heartbeat", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const id = c.req.param("id");
    if (id.length === 0) return c.json({ error: "invalid_resolution_job_id" }, 400);
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_resolution_job_heartbeat", issues: parsed.error.issues }, 400);
    const renewed = await store.heartbeat({ ...parsed.data, id });
    return c.json({ renewed });
  });

  return app;
}
