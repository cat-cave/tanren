import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { FixtureLease, FixtureLeaseAdapter } from "../../engine/contracts/fixtureLeaseAdapter.js";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import { PgFixtureLeaseRepository } from "../../engine/repositories/fixtureLeases.js";
import { PgFixtureLeaseAdapter } from "../../engine/verification/fixtureLease/index.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const date = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const acquireSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.enum(["org", "account", "channel", "dataset"]),
  correlationNamespace: z.string().min(1),
  expiresAt: date.optional(),
});
const releaseSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  leaseId: z.string().min(1),
  cleanupEvidenceHash: digest.optional(),
});
const observeExpirySchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  observedAt: date.optional(),
});

export interface FixtureLeaseRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  readonly adapter?: FixtureLeaseAdapter;
  readonly repository?: PgFixtureLeaseRepository;
}

function jsonLease(lease: FixtureLease) {
  return {
    ...lease,
    acquiredAt: lease.acquiredAt.toISOString(),
    ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt.toISOString() }),
  };
}

function trusted(verifier: MtlsPeerVerifier, c: Context): boolean {
  return verifyInternalPeer(verifier, c);
}

/** mTLS-only operational surface for acquiring, releasing, observing, and listing fixture leases. */
export function createInternalFixtureLeaseRoutes(deps: FixtureLeaseRouteDeps): Hono {
  const repository = deps.repository ?? new PgFixtureLeaseRepository(deps.pool);
  const adapter = deps.adapter ?? new PgFixtureLeaseAdapter(deps.pool, { repository });
  const app = new Hono();

  app.post("/internal/fixture-leases/acquire", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = acquireSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_fixture_lease_acquire", issues: parsed.error.issues }, 400);
    return c.json({ lease: jsonLease(await adapter.acquire(parsed.data)) }, 201);
  });

  app.post("/internal/fixture-leases/release", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = releaseSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_fixture_lease_release", issues: parsed.error.issues }, 400);
    const lease = await adapter.release(parsed.data);
    return c.json({ lease: lease === undefined ? null : jsonLease(lease) });
  });

  app.post("/internal/fixture-leases/observe-expiry", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = observeExpirySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success)
      return c.json({ error: "invalid_fixture_lease_expiry_observation", issues: parsed.error.issues }, 400);
    const expired = await adapter.observeExpiry(parsed.data);
    return c.json({ expired: expired.map((lease) => jsonLease(lease)) });
  });

  app.get("/internal/fixture-leases/:orgId/:projectId", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (orgId.length === 0 || projectId.length === 0) return c.json({ error: "invalid_fixture_lease_scope" }, 400);
    return c.json({ leases: (await repository.list(orgId, projectId)).map((lease) => jsonLease(lease)) });
  });

  return app;
}
