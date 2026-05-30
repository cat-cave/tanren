import { describe, expect, it } from "vitest";
import { GcpSecretManagerStore, gcpSecretIdFromRef } from "../src/engine/contracts/gcpSecretManager.js";
import { gcpSecretManagerFetch } from "./conformance/fakes/gcpSecretManagerFetch.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// Records every request AND delegates to the Secret Manager fake, so each test
// asserts both the exact wire shape (URL/method/headers/body, base64 payload)
// and the observable put/get/delete outcome — never spy-only.
function recordingGcpFetch(project: string): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const backing = gcpSecretManagerFetch(project);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return backing(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const base = "https://secretmanager.googleapis.com/v1/projects/p";

describe("gcpSecretIdFromRef", () => {
  it("replaces every disallowed character with an underscore", () => {
    expect(gcpSecretIdFromRef("credential/github_token/org/acme/default")).toBe(
      "credential_github_token_org_acme_default",
    );
    expect(gcpSecretIdFromRef("a.b@c:d")).toBe("a_b_c_d");
  });

  it("preserves letters, digits, hyphen and underscore", () => {
    expect(gcpSecretIdFromRef("Abc-123_xyz")).toBe("Abc-123_xyz");
  });

  it("caps the id at 255 characters", () => {
    const long = "x".repeat(300);
    expect(gcpSecretIdFromRef(long)).toHaveLength(255);
  });

  it("maps the empty ref to a single underscore", () => {
    expect(gcpSecretIdFromRef("")).toBe("_");
  });
});

describe("GcpSecretManagerStore wire contract", () => {
  it("creates the container then adds a base64-encoded version on put", async () => {
    const { fetchImpl, calls } = recordingGcpFetch("p");
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await store.put({ ref: "credential/token", value: "hello-secret" });

    const create = calls[0]!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe(`${base}/secrets?secretId=credential_token`);
    expect(create.headers["content-type"]).toBe("application/json");
    expect(create.headers["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(create.body)).toEqual({ replication: { automatic: {} } });

    const addVersion = calls[1]!;
    expect(addVersion.method).toBe("POST");
    expect(addVersion.url).toBe(`${base}/secrets/credential_token:addVersion`);
    const payload = JSON.parse(addVersion.body) as { payload: { data: string } };
    // Value is base64-encoded on the wire.
    expect(payload.payload.data).toBe(Buffer.from("hello-secret", "utf8").toString("base64"));
    expect(payload.payload.data).not.toBe("hello-secret");

    // Round-trip decodes back to the original value.
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "hello-secret",
    });
  });

  it("tolerates a pre-existing container (409) and still adds a version", async () => {
    const { fetchImpl, calls } = recordingGcpFetch("p");
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await store.put({ ref: "credential/token", value: "first" });
    calls.length = 0;
    // Second put: the create returns 409, which must be swallowed, then addVersion overwrites.
    await store.put({ ref: "credential/token", value: "second" });
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/secrets?secretId=credential_token`,
      `${base}/secrets/credential_token:addVersion`,
    ]);
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "second",
    });
  });

  it("accesses the latest version on get and decodes base64", async () => {
    const { fetchImpl, calls } = recordingGcpFetch("p");
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await store.put({ ref: "credential/token", value: "value-1" });
    calls.length = 0;
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "value-1",
    });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${base}/secrets/credential_token/versions/latest:access`);
  });

  it("returns undefined for a missing get (404)", async () => {
    const { fetchImpl } = recordingGcpFetch("p");
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.get("credential/absent")).resolves.toBeUndefined();
  });

  it("deletes the whole secret and is idempotent on a missing secret", async () => {
    const { fetchImpl, calls } = recordingGcpFetch("p");
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    calls.length = 0;
    await store.delete("credential/token");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${base}/secrets/credential_token`);
    await expect(store.get("credential/token")).resolves.toBeUndefined();
    // A second delete (now 404) must not throw.
    await expect(store.delete("credential/token")).resolves.toBeUndefined();
  });

  it("honours an apiBase override, stripping a trailing slash", async () => {
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        headers: {},
        body: "",
      });
      return new Response(JSON.stringify({ name: "x" }), { status: 200 });
    }) as typeof fetch;
    const store = new GcpSecretManagerStore({
      project: "p",
      accessToken: "tok",
      apiBase: "https://stub.local/v1/",
      fetchImpl,
    });
    await store.put({ ref: "credential/token", value: "v" });
    expect(calls[0]!.url).toBe("https://stub.local/v1/projects/p/secrets?secretId=credential_token");
  });

  it("throws when the access payload is not a string", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ payload: { data: 123 } }), { status: 200 })) as typeof fetch;
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(/did not contain payload data/u);
  });

  it("throws the contract error (not a TypeError) when the access body omits payload", async () => {
    // body.payload is undefined; the optional chain must yield undefined and the
    // store must raise its own "did not contain payload data" message.
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(/did not contain payload data/u);
  });

  it("throws on a non-404 create failure", async () => {
    // First call is the create-container POST; a 500 there must surface, not be swallowed.
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.put({ ref: "credential/x", value: "v" })).rejects.toThrow(
      /GCP Secret Manager create secret credential\/x failed: 500 nope/u,
    );
  });

  it("throws on a non-404 delete failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.delete("credential/x")).rejects.toThrow(
      /GCP Secret Manager delete secret credential\/x failed: 500 nope/u,
    );
  });

  it("throws with status and body on a non-404 error", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const store = new GcpSecretManagerStore({ project: "p", accessToken: "tok", fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(
      /GCP Secret Manager access secret credential\/x failed: 500 boom/u,
    );
  });
});
