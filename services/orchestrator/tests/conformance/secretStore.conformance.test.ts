// Per-implementation invocations of the SecretStore conformance suite. Both
// the in-memory store and a Vault-backed store (driven by an in-memory fetch
// stub that emulates Vault KV v2 semantics) are run through the SAME behavior
// spec. A future store (e.g. a Rust impl via its test shim) gets contract
// coverage by adding one harness here.
import { InMemorySecretStore, VaultSecretStore } from "../../src/engine/contracts/secretStore.js";
import type { SecretStore } from "../../src/engine/contracts/secretStore.js";
import { GcpSecretManagerStore } from "../../src/engine/contracts/gcpSecretManager.js";
import { AwsSecretsManagerStore } from "../../src/engine/contracts/awsSecretsManager.js";
import { OnePasswordStore } from "../../src/engine/contracts/onePassword.js";
import { describeSecretStoreConformance } from "./secretStoreConformance.js";
import { gcpSecretManagerFetch } from "./fakes/gcpSecretManagerFetch.js";
import { awsSecretsManagerFetch } from "./fakes/awsSecretsManagerFetch.js";
import { onePasswordConnectFetch } from "./fakes/onePasswordConnectFetch.js";

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
// Vault KV v2 path extractors: the data URL embeds `/data/<path>`; the
// metadata/list URL embeds `/metadata[/<path>]`.
const vaultDataPath = (url: string): string => decodeURIComponent(url.split("/data/")[1] ?? "");
const vaultMetaPath = (url: string): string => decodeURIComponent(url.split("/metadata")[1]?.replace(/^\//u, "") ?? "");

function vaultFetch(): typeof fetch {
  // Backing is keyed by the KV path (the ref) so the LIST emulation can walk the
  // path tree the way Vault KV v2 metadata LIST does.
  const backing = new Map<string, string>();
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        data?: { value?: string };
      };
      backing.set(vaultDataPath(url), body.data?.value ?? "");
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const existed = backing.delete(vaultDataPath(url));
      return new Response(null, { status: existed ? 204 : 404 });
    }
    if (method === "LIST") {
      // Immediate children of the metadata path; sub-trees carry a trailing `/`.
      const dir = vaultMetaPath(url);
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Set<string>();
      for (const key of backing.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (children.size === 0) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ data: { keys: [...children] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // GET
    const value = backing.get(vaultDataPath(url));
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

// --- GcpSecretManagerStore (mocked Secret Manager v1) -----------------------
describeSecretStoreConformance("GcpSecretManagerStore", {
  make: (): SecretStore =>
    new GcpSecretManagerStore({
      project: "test-project",
      accessToken: "test-token",
      fetchImpl: gcpSecretManagerFetch("test-project"),
    }),
});

// --- AwsSecretsManagerStore (mocked Secrets Manager JSON API) ----------------
describeSecretStoreConformance("AwsSecretsManagerStore", {
  make: (): SecretStore =>
    new AwsSecretsManagerStore({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      region: "us-east-1",
      fetchImpl: awsSecretsManagerFetch(),
    }),
});

// --- OnePasswordStore (mocked Connect API) ----------------------------------
describeSecretStoreConformance("OnePasswordStore", {
  make: (): SecretStore =>
    new OnePasswordStore({
      connectUrl: "https://connect.example.com",
      token: "test-token",
      vaultId: "vault-uuid",
      fetchImpl: onePasswordConnectFetch("vault-uuid"),
    }),
});
