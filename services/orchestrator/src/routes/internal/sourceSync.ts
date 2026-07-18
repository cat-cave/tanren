import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import { SourceSyncOutboxStore } from "../../engine/repositories/sourceSyncOutbox.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const claimSchema = z
  .object({
    orgId: z.string().min(1),
    workerId: z.string().min(1).max(256),
    leaseMs: z.number().int().positive().optional(),
    sourceSyncOutboxId: z.string().min(1).optional(),
  })
  .strict();
const redriveSchema = z.object({ orgId: z.string().min(1) }).strict();

export interface SourceSyncRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
}

/** mTLS-only operational surface for source-sync workers and bounded redrives. */
export function createInternalSourceSyncRoutes(deps: SourceSyncRouteDeps): Hono {
  const app = new Hono();
  app.post("/internal/source-sync/claim", async (c: Context) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_source_sync_claim", issues: parsed.error.issues }, 400);
    const outbox = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => {
      const input = {
        orgId: parsed.data.orgId,
        workerId: parsed.data.workerId,
        leaseMs: parsed.data.leaseMs ?? 5 * 60_000,
      };
      return parsed.data.sourceSyncOutboxId === undefined
        ? SourceSyncOutboxStore.claimNext(client, input)
        : SourceSyncOutboxStore.claim(client, { ...input, id: parsed.data.sourceSyncOutboxId });
    });
    return c.json({ outbox: outbox ?? null });
  });
  app.post("/internal/source-sync/:outboxId/redrive", async (c: Context) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = redriveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_source_sync_redrive", issues: parsed.error.issues }, 400);
    const outboxId = c.req.param("outboxId");
    if (outboxId === undefined || outboxId.length === 0) return c.json({ error: "invalid_source_sync_outbox_id" }, 400);
    const outbox = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
      SourceSyncOutboxStore.redrive(client, parsed.data.orgId, outboxId),
    );
    if (outbox === undefined) return c.json({ error: "source_sync_outbox_not_found" }, 404);
    return c.json({ outbox });
  });
  return app;
}
