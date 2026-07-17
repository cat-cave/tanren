// PG-gated tenant proof for webhook delivery idempotency and claim leases.
// Run with TANREN_RLS_DB_TEST=1; the ordinary test gate skips this suite.

import { migrate, runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { WebhookEventStore } from "../src/engine/repositories/webhookEvents.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_bh3_webhook_a";
const ORG_B = "org_bh3_webhook_b";
const SOURCE_A = "src_bh3_webhook_a";
const SOURCE_B = "src_bh3_webhook_b";

function dbName(): string {
  return `tanren_webhook_intake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withRole(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seedOrgAndSource(pool: Pool, orgId: string, sourceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO inbox_sources (id, org_id, kind, name, config)
     VALUES ($1, $2, 'issues', $1, '{"owner":"cat-cave","repo":"tanren","labels":[]}'::jsonb)`,
    [sourceId, orgId],
  );
}

describeDb("webhook intake hardening — idempotency, leases, and RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, database) });
    await seedOrgAndSource(ownerPool, ORG_A, SOURCE_A);
    await seedOrgAndSource(ownerPool, ORG_B, SOURCE_B);
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("deduplicates delivery ids, serializes claims, reclaims expired claims, and isolates orgs", async () => {
    const signedAt = new Date("2026-07-17T12:00:00.000Z");
    const first = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.persist(client, {
        sourceId: SOURCE_A,
        orgId: ORG_A,
        eventType: "issues",
        provider: "github",
        deliveryId: "delivery-1",
        payload: { z: 1, a: 2 },
        signatureAlgo: "hmac-sha256",
        signatureKeyVersion: "key-v1",
        deliverySignedAt: signedAt,
      }),
    );
    const duplicate = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.persist(client, {
        sourceId: SOURCE_A,
        orgId: ORG_A,
        eventType: "issues",
        provider: "github",
        deliveryId: "delivery-1",
        payload: { a: 2, z: 1 },
        signatureAlgo: "hmac-sha256",
        signatureKeyVersion: "key-v2",
        deliverySignedAt: new Date(),
      }),
    );
    expect(duplicate.id).toBe(first.id);
    expect(first.canonicalPayloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(duplicate.canonicalPayloadHash).toBe(first.canonicalPayloadHash);
    expect(duplicate.signatureKeyVersion).toBe("key-v1");
    const sourceADeliveries = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.listUndriven(client, 100),
    );
    expect(sourceADeliveries).toHaveLength(1);

    const raced = await Promise.all([
      runWithOrgScope(appPool, ORG_A, (client) =>
        WebhookEventStore.claim(client, { id: first.id, workerId: "worker-a", leaseMs: 60_000 }),
      ),
      runWithOrgScope(appPool, ORG_A, (client) =>
        WebhookEventStore.claim(client, { id: first.id, workerId: "worker-b", leaseMs: 60_000 }),
      ),
    ]);
    expect(raced.filter((event) => event !== undefined)).toHaveLength(1);
    const winner = raced.find((event) => event !== undefined);
    expect(winner?.claimOwner).toMatch(/^worker-[ab]$/u);

    await ownerPool.query("UPDATE webhook_events SET claim_expires_at = now() - interval '1 second' WHERE id = $1", [
      first.id,
    ]);
    const reclaimed = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.claim(client, { id: first.id, workerId: "worker-reclaimer", leaseMs: 60_000 }),
    );
    expect(reclaimed?.claimOwner).toBe("worker-reclaimer");
    await runWithOrgScope(appPool, ORG_A, (client) => WebhookEventStore.complete(client, first.id, "worker-reclaimer"));
    const completed = await ownerPool.query<{
      status: string;
      claim_owner: string | null;
      claim_expires_at: Date | null;
    }>("SELECT status, claim_owner, claim_expires_at FROM webhook_events WHERE id = $1", [first.id]);
    expect(completed.rows[0]).toMatchObject({ status: "processed", claim_owner: null, claim_expires_at: null });

    const otherOrg = await runWithOrgScope(appPool, ORG_B, (client) =>
      WebhookEventStore.persist(client, {
        sourceId: SOURCE_B,
        orgId: ORG_B,
        eventType: "issues",
        provider: "github",
        deliveryId: "delivery-1",
        payload: { org: "b" },
      }),
    );
    expect(otherOrg.id).not.toBe(first.id);
    await expect(
      runWithOrgScope(appPool, ORG_B, (client) =>
        WebhookEventStore.claim(client, { id: first.id, workerId: "cross-org", leaseMs: 60_000 }),
      ),
    ).resolves.toBeUndefined();
    const orgAAfterProcessing = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.listUndriven(client, 100),
    );
    const orgBVisible = await runWithOrgScope(appPool, ORG_B, (client) => WebhookEventStore.listUndriven(client, 100));
    expect(orgAAfterProcessing).toHaveLength(0);
    expect(orgBVisible).toHaveLength(1);

    const bClaim = await runWithOrgScope(appPool, ORG_B, (client) =>
      WebhookEventStore.claim(client, { id: otherOrg.id, workerId: "worker-b", leaseMs: 60_000 }),
    );
    expect(bClaim?.orgId).toBe(ORG_B);
    await runWithOrgScope(appPool, ORG_B, (client) => WebhookEventStore.release(client, otherOrg.id, "worker-b"));
    const released = await runWithOrgScope(appPool, ORG_B, (client) => WebhookEventStore.listUndriven(client, 100));
    expect(released).toHaveLength(1);
  });
});
