import { describe, expect, it } from "vitest";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { EventName } from "../../src/engine/events/index.js";
import { PgFixtureLeaseRepository } from "../../src/engine/repositories/fixtureLeases.js";
import { PgFixtureLeaseAdapter } from "../../src/engine/verification/fixtureLease/index.js";
import { MemoryDb } from "./conformanceMemoryDb.js";
import { FixtureLeaseScopedClient } from "./fixtureLeaseMemoryDb.js";

const ORG_A = "org_fixture_a";
const ORG_B = "org_fixture_b";
const PROJECT_A = "project_fixture_a";
const PROJECT_B = "project_fixture_b";
const CLEANUP_HASH = `sha256:${"a".repeat(64)}`;

class RecordingEventStore implements EventStore {
  public readonly events: Array<{ eventType: string; payload: unknown }> = [];

  public async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ eventType: input.eventType, payload: input.payload });
  }
}

describe("FixtureLeaseAdapter postgres SQL conformance", () => {
  it("acquires, releases, expires, emits named events, and does not leak across org scopes", async () => {
    const db = new MemoryDb();
    const events = new RecordingEventStore();
    const repository = new PgFixtureLeaseRepository({} as never);
    const adapter = new PgFixtureLeaseAdapter({} as never, {
      repository,
      eventStore: events,
      withOrgScope: async (orgId, operation) => operation(new FixtureLeaseScopedClient(db, orgId) as never),
    });

    const acquired = await adapter.acquire({
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "channel",
      correlationNamespace: "run:fixture:release",
    });
    const idempotent = await adapter.acquire({
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "channel",
      correlationNamespace: "run:fixture:release",
    });
    expect(idempotent.leaseId).toBe(acquired.leaseId);
    expect(acquired.state).toBe("leased");

    const released = await adapter.release({
      orgId: ORG_A,
      projectId: PROJECT_A,
      leaseId: acquired.leaseId,
      cleanupEvidenceHash: CLEANUP_HASH,
    });
    expect(released).toMatchObject({ state: "released", cleanupEvidenceHash: CLEANUP_HASH });

    const expiring = await adapter.acquire({
      orgId: ORG_A,
      projectId: PROJECT_A,
      kind: "dataset",
      correlationNamespace: "run:fixture:expiry",
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const expired = await adapter.observeExpiry({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ leaseId: expiring.leaseId, state: "expired" });

    await adapter.acquire({
      orgId: ORG_B,
      projectId: PROJECT_B,
      kind: "account",
      correlationNamespace: "run:fixture:foreign",
    });
    await expect(
      adapter.release({ orgId: ORG_B, projectId: PROJECT_B, leaseId: acquired.leaseId }),
    ).resolves.toBeUndefined();
    const foreignRead = await new FixtureLeaseScopedClient(db, ORG_B).query(
      "SELECT org_id FROM fixture_leases WHERE org_id = $1 AND project_id = $2 ORDER BY acquired_at ASC, lease_id ASC",
      [ORG_A, PROJECT_A],
    );
    expect(foreignRead.rowCount).toBe(0);
    expect(events.events.map((event) => event.eventType)).toEqual([
      "fixture.lease.acquired",
      "fixture.lease.released",
      "fixture.lease.acquired",
      "fixture.lease.expired",
      "fixture.lease.acquired",
    ]);
  });
});
