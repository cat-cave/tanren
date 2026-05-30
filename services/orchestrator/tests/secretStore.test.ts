import { describe, expect, it, vi } from "vitest";
import { VaultSecretStore } from "../src/engine/contracts/secretStore.js";

describe("VaultSecretStore", () => {
  it("uses Vault secret/ KV v2 request shapes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === undefined) {
        return new Response(JSON.stringify({ data: { data: { value: "private-key" } } }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const store = new VaultSecretStore({
      addr: "http://vault:8200/",
      token: "dev-root-token",
      fetchImpl,
    });

    await store.put({ ref: "runner/local/identity", value: "private-key" });
    await expect(store.get("runner/local/identity")).resolves.toEqual({
      ref: "runner/local/identity",
      value: "private-key",
    });
    await store.delete("runner/local/identity");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Vault-Token": "dev-root-token" },
        body: JSON.stringify({ data: { value: "private-key" } }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({
        headers: { "Content-Type": "application/json", "X-Vault-Token": "dev-root-token" },
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://vault:8200/v1/secret/data/runner/local/identity",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("returns undefined for missing Vault secrets", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
    const store = new VaultSecretStore({
      addr: "http://vault:8200",
      token: "dev-root-token",
      fetchImpl,
    });

    await expect(store.get("credential/missing")).resolves.toBeUndefined();
  });

  it("routes through a configured KV mount in the data path", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      calls.push(typeof url === "string" ? url : url.toString());
      return new Response(JSON.stringify({ data: { data: { value: "v" } } }), { status: 200 });
    });
    const store = new VaultSecretStore({
      addr: "http://vault:8200",
      token: "t",
      mount: "kv-prod",
      fetchImpl,
    });
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "v",
    });
    expect(calls[0]).toBe("http://vault:8200/v1/kv-prod/data/credential/token");
  });

  it("reads the value from the nested KV v2 data.data envelope", async () => {
    // The real value lives at body.data.data.value; a flattened envelope must not resolve.
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: { value: "shallow" } }), { status: 200 }),
    );
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl });
    await expect(store.get("credential/token")).rejects.toThrow(/did not contain a string value/);
  });

  it("treats a 404 on delete as a no-op but surfaces other delete failures", async () => {
    const okThen500 = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl: okThen500 });
    await expect(store.delete("credential/token")).rejects.toThrow(
      /Vault delete secret credential\/token failed: 500 boom/,
    );

    const missing = vi.fn<typeof fetch>(async () => new Response("absent", { status: 404 }));
    const store2 = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl: missing });
    await expect(store2.delete("credential/token")).resolves.toBeUndefined();
  });

  it("surfaces status and body when a Vault read fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("denied", { status: 403 }));
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl });
    await expect(store.get("credential/token")).rejects.toThrow(
      /Vault read secret credential\/token failed: 403 denied/,
    );
  });

  it("surfaces status and body when a Vault write fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl });
    await expect(store.put({ ref: "credential/token", value: "v" })).rejects.toThrow(
      /Vault store secret credential\/token failed: 403 forbidden/,
    );
  });

  it("raises the contract error (not a TypeError) when the KV envelope omits data", async () => {
    // body.data is absent; the optional chain must yield undefined so the store
    // raises its own "did not contain a string value" message.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({}), { status: 200 }));
    const store = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl });
    await expect(store.get("credential/token")).rejects.toThrow(/did not contain a string value/);
  });
});
