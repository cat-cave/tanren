// Conformance for the durable webhook-events repository seam. The in-memory
// pg-shaped client recognizes the production SQL and preserves org-scoped RLS
// visibility, source lineage, delivery deduplication, and lease behavior.

import { describe, expect, it } from "vitest";
import { pgRepositories, type QueryClient } from "../../src/engine/contracts/repositories.js";
import { WebhookEventLineageError } from "../../src/engine/repositories/webhookEvents.js";
import { ForgeRecoveryDb, forgeRecoveryClientForOrg } from "./forgeRecoveryMemoryDb.js";

const ORG_A = "org_a";
const ORG_B = "org_b";
const repos = pgRepositories;
const db = () => new ForgeRecoveryDb();
const clientA = (d: ForgeRecoveryDb): QueryClient => forgeRecoveryClientForOrg(d, ORG_A);
const clientB = (d: ForgeRecoveryDb): QueryClient => forgeRecoveryClientForOrg(d, ORG_B);

describe("Repositories conformance: forge/recovery webhook events (in-memory pg)", () => {
  async function seedWebhookSource(d: ForgeRecoveryDb, orgId = ORG_A, enabled = true) {
    return repos.inbox.createSource(orgId === ORG_A ? clientA(d) : clientB(d), {
      orgId,
      projectId: null,
      kind: "manual",
      name: "Webhook source",
      enabled,
    });
  }

  async function persist(client: QueryClient, sourceId: string, deliveryId: string, orgId = ORG_A) {
    return repos.webhookEvents.persist(client, {
      sourceId,
      orgId,
      eventType: "issues",
      deliveryId,
      payload: { action: "opened" },
    });
  }

  it("persists a received row, sweeps undriven rows, and marks one processed", async () => {
    const d = db();
    const source = await seedWebhookSource(d);
    const event = await persist(clientA(d), source.id, "d1");
    expect(event.status).toBe("received");
    expect(event.attempts).toBe(0);
    expect((await repos.webhookEvents.listUndriven(clientA(d), 10)).map((row) => row.id)).toEqual([event.id]);
    await repos.webhookEvents.markProcessed(clientA(d), event.id);
    expect(await repos.webhookEvents.listUndriven(clientA(d), 10)).toHaveLength(0);
  });

  it("records failures by NATURE, not a count", async () => {
    const d = db();
    const source = await seedWebhookSource(d);
    const event = await persist(clientA(d), source.id, "d1");
    expect(await repos.webhookEvents.recordFailure(clientA(d), event.id, "blip 1", false)).toBe("failed");
    expect(await repos.webhookEvents.recordFailure(clientA(d), event.id, "blip 2", false)).toBe("failed");
    expect(await repos.webhookEvents.recordFailure(clientA(d), event.id, "blip 3", false)).toBe("failed");
    const undriven = await repos.webhookEvents.listUndriven(clientA(d), 10);
    expect(undriven).toHaveLength(1);
    expect(undriven[0]?.attempts).toBe(3);
    expect(await repos.webhookEvents.recordFailure(clientA(d), event.id, "poison", true)).toBe("dead_lettered");
    expect(await repos.webhookEvents.listUndriven(clientA(d), 10)).toHaveLength(0);
  });

  it("scopes webhook reads and mutations to the caller org", async () => {
    const d = db();
    const source = await seedWebhookSource(d);
    const event = await persist(clientA(d), source.id, "d1");
    expect(await repos.webhookEvents.listUndriven(clientB(d), 10)).toHaveLength(0);
    await repos.webhookEvents.markProcessed(clientB(d), event.id);
    expect((await repos.webhookEvents.listUndriven(clientA(d), 10))[0]?.status).toBe("received");
    expect(await repos.webhookEvents.recordFailure(clientB(d), event.id, "x", false)).toBe("failed");
    expect((await repos.webhookEvents.listUndriven(clientA(d), 10))[0]?.attempts).toBe(0);
  });

  it("rejects missing, foreign, disabled, inactive, and project-invalid sources", async () => {
    const d = db();
    const disabled = await seedWebhookSource(d, ORG_A, false);
    const inactive = await seedWebhookSource(d);
    const projectInvalid = await seedWebhookSource(d);
    const foreign = await seedWebhookSource(d, ORG_B);
    d.inboxSources.find((source) => source.id === inactive.id)!.state = "needs_attention";
    d.inboxSources.find((source) => source.id === projectInvalid.id)!.project_id = "project_missing";

    for (const sourceId of ["src_missing", foreign.id, disabled.id, inactive.id, projectInvalid.id]) {
      await expect(persist(clientA(d), sourceId, `delivery-${sourceId}`)).rejects.toBeInstanceOf(
        WebhookEventLineageError,
      );
    }
  });

  it("deduplicates a non-null provider delivery id after the source-validity gate", async () => {
    const d = db();
    const source = await seedWebhookSource(d);
    const input = {
      sourceId: source.id,
      orgId: ORG_A,
      eventType: "issues",
      deliveryId: "d1",
      payload: { action: "opened" },
    };
    const first = await repos.webhookEvents.persistWithOutcome(clientA(d), input);
    const duplicate = await repos.webhookEvents.persistWithOutcome(clientA(d), input);
    expect(first).toMatchObject({ inserted: true });
    expect(duplicate).toMatchObject({ inserted: false, event: { id: first.event.id } });
    const nullDelivery = { ...input, deliveryId: null };
    const noDeliveryFirst = await repos.webhookEvents.persistWithOutcome(clientA(d), nullDelivery);
    const noDeliverySecond = await repos.webhookEvents.persistWithOutcome(clientA(d), nullDelivery);
    expect(noDeliveryFirst).toMatchObject({ inserted: true });
    expect(noDeliverySecond).toMatchObject({ inserted: true });
    expect(noDeliverySecond.event.id).not.toBe(noDeliveryFirst.event.id);
    expect(d.webhookEvents).toHaveLength(3);
  });

  it("claims once, reclaims an expired lease, and releases only the caller's claim", async () => {
    const d = db();
    const source = await seedWebhookSource(d);
    const event = await persist(clientA(d), source.id, "d1");
    const claim = (workerId: string) =>
      repos.webhookEvents.claim(clientA(d), { id: event.id, workerId, leaseMs: 60_000 });
    expect(await claim("worker_a")).toMatchObject({ id: event.id, claimOwner: "worker_a" });
    expect(await claim("worker_b")).toBeUndefined();
    expect(await repos.webhookEvents.release(clientA(d), event.id, "worker_b")).toBe(false);
    expect(await repos.webhookEvents.release(clientA(d), event.id, "worker_a")).toBe(true);
    expect((await repos.webhookEvents.listUndriven(clientA(d), 10)).map((row) => row.id)).toEqual([event.id]);
    await claim("worker_a");
    d.webhookEvents[0]!.claim_expires_at = new Date(0).toISOString();
    expect(await claim("worker_b")).toMatchObject({ id: event.id, claimOwner: "worker_b" });
  });
});
