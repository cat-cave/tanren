import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import { MANAGED_ROUTER_KEY_ENV, seedPlatformCredentials } from "./seed-platform-creds.js";

describe("seedPlatformCredentials", () => {
  it("writes the managed-router key to the platform ref from the env var", async () => {
    const store = new InMemorySecretStore();
    const written = await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" });

    expect(written).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-test-123");
  });

  it("is platform-scoped — never writes a tenant-namespaced credential ref", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" });

    // The platform ref lives under `credential/openrouter/platform/...`, NOT the
    // tenant `credential/<kind>/org/...` shape the operator API derives.
    const refs = await store.list("credential/");
    expect(refs).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    expect(refs.every((ref) => !ref.includes("/org/") && !ref.includes("/me/"))).toBe(true);
  });

  it("is idempotent: re-seeding upserts the same ref with the new value", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-old" });
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-new" });

    const refs = await store.list("credential/");
    expect(refs).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-new");
  });

  it("FAILS LOUD (throws) when the key env var is absent — no silent skip", async () => {
    const store = new InMemorySecretStore();
    await expect(seedPlatformCredentials(store, {})).rejects.toThrow(MANAGED_ROUTER_KEY_ENV);
  });

  it("FAILS LOUD when the key env var is blank/whitespace, and writes nothing", async () => {
    const store = new InMemorySecretStore();
    await expect(seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "   " })).rejects.toThrow(
      "missing or blank",
    );
    // Fail-before-write: a blank value must not leave a half-seeded platform ref.
    expect(await store.list("credential/")).toStrictEqual([]);
  });

  it("trims surrounding whitespace from the seeded key", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "  sk-or-padded\n" });
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-padded");
  });
});
