import { describe, expect, it } from "vitest";
import { OnePasswordStore, onePasswordTitleFromRef } from "../src/engine/contracts/onePassword.js";
import { onePasswordConnectFetch } from "./conformance/fakes/onePasswordConnectFetch.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// Records every request AND delegates to the Connect fake, so each test asserts
// both the exact wire shape (URL/method/headers/body, create-vs-update,
// concealed field) and the observable put/get/delete outcome — never spy-only.
function recordingOpFetch(vaultId: string): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const backing = onePasswordConnectFetch(vaultId);
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

const opts = {
  connectUrl: "https://connect.example.com",
  token: "connect-tok",
  vaultId: "vault-uuid",
};
const itemsUrl = "https://connect.example.com/v1/vaults/vault-uuid/items";

describe("onePasswordTitleFromRef", () => {
  it("uses the ref verbatim as the item title", () => {
    expect(onePasswordTitleFromRef("credential/github_token/org/acme/default")).toBe(
      "credential/github_token/org/acme/default",
    );
  });
});

describe("OnePasswordStore wire contract", () => {
  it("looks up by title filter then POSTs a new PASSWORD item with a CONCEALED field", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await store.put({ ref: "credential/token", value: "secret-value" });

    const lookup = calls[0]!;
    expect(lookup.method).toBe("GET");
    expect(lookup.url).toBe(`${itemsUrl}?filter=${encodeURIComponent('title eq "credential/token"')}`);
    expect(lookup.headers["authorization"]).toBe("Bearer connect-tok");
    expect(lookup.headers["content-type"]).toBe("application/json");

    const create = calls[1]!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe(itemsUrl);
    expect(JSON.parse(create.body)).toEqual({
      vault: { id: "vault-uuid" },
      title: "credential/token",
      category: "PASSWORD",
      fields: [{ label: "password", type: "CONCEALED", value: "secret-value" }],
    });

    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "secret-value",
    });
  });

  it("strips a trailing slash from the configured connect url", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, connectUrl: "https://connect.example.com/", fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    // No double slash before /v1 even though the url had a trailing slash.
    expect(calls[0]!.url).toBe(`${itemsUrl}?filter=${encodeURIComponent('title eq "credential/token"')}`);
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "v",
    });
  });

  it("PUTs to the existing item url (with its id) when the item already exists", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await store.put({ ref: "credential/token", value: "first" });
    calls.length = 0;
    await store.put({ ref: "credential/token", value: "second" });

    // lookup (GET) then update.
    const update = calls[1]!;
    expect(update.method).toBe("PUT");
    expect(update.url).toBe(`${itemsUrl}/item-1`);
    const body = JSON.parse(update.body) as { id?: string; fields: { value: string }[] };
    expect(body.id).toBe("item-1");
    expect(body.fields[0]!.value).toBe("second");

    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "second",
    });
  });

  it("uses a configured field label for the concealed value", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fieldLabel: "api_key", fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    const create = JSON.parse(calls[1]!.body) as { fields: { label: string }[] };
    expect(create.fields[0]!.label).toBe("api_key");
    // get() reads back via the same label.
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "v",
    });
  });

  it("defaults the field label to 'password' when none is configured", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    const create = JSON.parse(calls[1]!.body) as { fields: { label: string }[] };
    expect(create.fields[0]!.label).toBe("password");
  });

  it("returns undefined from get when the title lookup yields no item", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.get("credential/absent")).resolves.toBeUndefined();
    // Only the lookup is issued — no item-fetch.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("?filter=");
  });

  it("reads the value from the matching field label on get, sending auth headers", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await store.put({ ref: "credential/token", value: "the-value" });
    calls.length = 0;
    await expect(store.get("credential/token")).resolves.toEqual({
      ref: "credential/token",
      value: "the-value",
    });
    // get(): lookup then fetch by id, both authenticated.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls[1]!.url).toBe(`${itemsUrl}/item-1`);
    expect(calls[1]!.headers["authorization"]).toBe("Bearer connect-tok");
  });

  it("returns undefined when the resolved item 404s on fetch", async () => {
    // Lookup finds an id, but the item GET 404s — get() must resolve undefined.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "GET" && url.includes("?filter=")) {
        return new Response(JSON.stringify([{ id: "item-1" }]), { status: 200 });
      }
      return new Response("gone", { status: 404 });
    }) as typeof fetch;
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.get("credential/token")).resolves.toBeUndefined();
  });

  it("throws when the resolved field carries a non-string value", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "GET" && url.includes("?filter=")) {
        return new Response(JSON.stringify([{ id: "item-1" }]), { status: 200 });
      }
      // Field present with the right label but a non-string value.
      return new Response(JSON.stringify({ id: "item-1", fields: [{ label: "password", value: 123 }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.get("credential/token")).rejects.toThrow(/did not contain a 'password' field/);
  });

  it("throws when the resolved item lacks the configured field", async () => {
    let phase = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "GET" && url.includes("?filter=")) {
        return new Response(JSON.stringify([{ id: "item-1" }]), { status: 200 });
      }
      phase++;
      // Item exists but carries a differently-labelled field.
      return new Response(JSON.stringify({ id: "item-1", fields: [{ label: "username", value: "x" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.get("credential/token")).rejects.toThrow(/did not contain a 'password' field/);
    expect(phase).toBe(1);
  });

  it("deletes the resolved item and is a no-op when the item is absent", async () => {
    const { fetchImpl, calls } = recordingOpFetch("vault-uuid");
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await store.put({ ref: "credential/token", value: "v" });
    calls.length = 0;
    await store.delete("credential/token");
    // delete(): lookup then DELETE by id.
    expect(calls[1]!.method).toBe("DELETE");
    expect(calls[1]!.url).toBe(`${itemsUrl}/item-1`);
    await expect(store.get("credential/token")).resolves.toBeUndefined();

    calls.length = 0;
    // Absent item: only the lookup runs, no DELETE.
    await expect(store.delete("credential/token")).resolves.toBeUndefined();
    expect(calls.every((c) => c.method !== "DELETE")).toBe(true);
  });

  it("throws with status and body when the lookup fails", async () => {
    const fetchImpl = (async () => new Response("denied", { status: 403 })) as typeof fetch;
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.get("credential/x")).rejects.toThrow(
      /1Password list items for credential\/x failed: 403 denied/,
    );
  });

  it("surfaces a non-404 delete failure rather than treating it as a no-op", async () => {
    // Lookup resolves an id; the DELETE returns 500, which must throw.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "GET" && url.includes("?filter=")) {
        return new Response(JSON.stringify([{ id: "item-1" }]), { status: 200 });
      }
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const store = new OnePasswordStore({ ...opts, fetchImpl });
    await expect(store.delete("credential/token")).rejects.toThrow(
      /1Password delete secret credential\/token failed: 500 boom/,
    );
  });
});
