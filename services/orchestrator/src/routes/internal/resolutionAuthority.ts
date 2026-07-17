import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import type { ResolutionAuthority } from "../../engine/contracts/resolutionAuthority.js";
import { buildResolutionAuthority } from "../../engine/governance/resolutionAuthority.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const authorizeSchema = z.object({ orgId: z.string().min(1) }).strict();

export interface InternalResolutionAuthorityRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  readonly authority?: ResolutionAuthority;
}

/**
 * The only network authorization surface is on the separate mTLS listener.
 * It accepts no verdict/evidence fields: the authority re-reads the durable
 * snapshot itself, so a caller cannot manufacture a passing production result.
 */
export function createInternalResolutionAuthorityRoutes(deps: InternalResolutionAuthorityRouteDeps): Hono {
  const authority = deps.authority ?? buildResolutionAuthority(deps.pool);
  const app = new Hono();
  app.post("/internal/resolution-authority/:resolutionJobId/authorize", async (c: Context) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = authorizeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_resolution_authorization", issues: parsed.error.issues }, 400);
    const resolutionJobId = c.req.param("resolutionJobId");
    if (resolutionJobId === undefined || resolutionJobId.length === 0) {
      return c.json({ error: "invalid_resolution_job_id" }, 400);
    }
    return c.json(await authority.authorize({ orgId: parsed.data.orgId, resolutionJobId }));
  });
  return app;
}
