import { describe, expect, it } from "vitest";
import { AppEnvironmentStore } from "../../src/engine/repositories/appEnvironment.js";
import { systemActor } from "../../src/engine/state/actor.js";
import { IntegrationMemoryDb } from "../helpers/integrationMemoryDb.js";

function seeded() {
  const db = new IntegrationMemoryDb();
  db.seedProject("proj_a", "org_a");
  db.seedProject("proj_b", "org_b");
  return { db, client: db.clientForOrg("org_a") };
}

const base = { orgId: "org_a", projectId: "proj_a", environment: "test" as const };

describe("AppEnvironmentStore conformance", () => {
  it("round-trips secret refs with explicit generations", async () => {
    const { client } = seeded();
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "RESEND_API_KEY", valueRef: "secret://proj_a/resend", secretGeneration: 1, scopes: ["test"] },
      systemActor,
    );
    expect(
      await AppEnvironmentStore.get(client, "org_a", "proj_a", "test", "RESEND_API_KEY", systemActor),
    ).toMatchObject({
      valueRef: "secret://proj_a/resend",
      secretGeneration: 1,
      plainValue: null,
    });
  });

  it("enforces value XOR and updates only the same environment key", async () => {
    const { client } = seeded();
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "PUBLIC_URL", plainValue: "v1", scopes: ["test"] },
      systemActor,
    );
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "PUBLIC_URL", plainValue: "v2", scopes: ["test"] },
      systemActor,
    );
    await AppEnvironmentStore.upsert(
      client,
      { ...base, environment: "production", key: "PUBLIC_URL", plainValue: "prod", scopes: ["runtime"] },
      systemActor,
    );
    expect(await AppEnvironmentStore.list(client, "org_a", "proj_a", "test", systemActor)).toHaveLength(1);
    expect(
      (await AppEnvironmentStore.get(client, "org_a", "proj_a", "test", "PUBLIC_URL", systemActor))?.plainValue,
    ).toBe("v2");
    await expect(
      AppEnvironmentStore.upsert(client, { ...base, key: "BAD", scopes: ["test"] }, systemActor),
    ).rejects.toThrow(/exactly one/u);
  });

  it("deletes in-scope rows and hides cross-org rows", async () => {
    const { db, client } = seeded();
    await AppEnvironmentStore.upsert(client, { ...base, key: "K", plainValue: "v", scopes: ["test"] }, systemActor);
    expect(await AppEnvironmentStore.list(db.clientForOrg("org_b"), "org_a", "proj_a", "test", systemActor)).toEqual(
      [],
    );
    expect(await AppEnvironmentStore.delete(client, "org_a", "proj_a", "test", "K", systemActor)).toBe(true);
    expect(await AppEnvironmentStore.delete(client, "org_a", "proj_a", "test", "K", systemActor)).toBe(false);
  });
});
