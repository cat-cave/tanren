// Per-implementation invocations of the SecretStore conformance suite. Both
// the in-memory store and a Vault-backed store (driven by an in-memory fetch
// stub that emulates Vault KV v2 semantics) are run through the SAME behavior
// spec. A future store (e.g. a Rust impl via its test shim) gets contract
// coverage by adding one harness here.
import { InMemorySecretStore, VaultSecretStore } from "../../src/engine/contracts/secretStore.js";
import type { SecretStore } from "../../src/engine/contracts/secretStore.js";
import { describeSecretStoreConformance } from "./secretStoreConformance.js";

// --- InMemorySecretStore ----------------------------------------------------
describeSecretStoreConformance("InMemorySecretStore", {
  make: (): SecretStore => new InMemorySecretStore(),
});

/**
 * In-memory `fetch` that emulates the subset of Vault KV v2 the
 * VaultSecretStore drives: POST writes `data.value`, GET reads it back (404
 * when absent), DELETE removes it (404 when absent). Each harness instance
 * gets its own backing map so conformance specs stay isolated.
 */
function vaultFetch(): typeof fetch {
  const backing = new Map<string, string>();
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        data?: { value?: string };
      };
      backing.set(url, body.data?.value ?? "");
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const existed = backing.delete(url);
      return new Response(null, { status: existed ? 204 : 404 });
    }
    // GET
    const value = backing.get(url);
    if (value === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ data: { data: { value } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// --- VaultSecretStore (mocked Vault KV v2) ----------------------------------
describeSecretStoreConformance("VaultSecretStore", {
  make: (): SecretStore =>
    new VaultSecretStore({
      addr: "http://vault:8200",
      token: "test-token",
      fetchImpl: vaultFetch(),
    }),
});
