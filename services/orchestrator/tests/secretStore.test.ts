import { describe, expect, it, vi } from "vitest";
import { VaultSecretStore } from "../src/engine/contracts/secretStore.js";

describe("VaultSecretStore", () => {
  it("uses Vault secret/ KV v2 request shapes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ data: { data: { value: "private-key" } } }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const store = new VaultSecretStore({ addr: "http://vault:8200/", token: "dev-root-token", fetchImpl });

    await store.put({ ref: "runner/local/identity", value: "private-key" });
    await expect(store.get("runner/local/identity")).resolves.toEqual({
      ref: "runner/local/identity",
      value: "private-key"
    });
    await store.delete("runner/local/identity");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Vault-Token": "dev-root-token" },
        body: JSON.stringify({ data: { value: "private-key" } })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({ headers: { "Content-Type": "application/json", "X-Vault-Token": "dev-root-token" } })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("returns undefined for missing Vault secrets", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "dev-root-token", fetchImpl });

    await expect(store.get("credential/missing")).resolves.toBeUndefined();
  });
});
