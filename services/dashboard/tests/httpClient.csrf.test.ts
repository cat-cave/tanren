// Unit: OrchestratorHttpClient.sendJson attaches x-csrf-token when csrfToken is set,
// and omits it for local-dev actor mode (no session / empty token).

import { describe, expect, it, vi } from "vitest";
import { OrchestratorHttpClient } from "../src/api/httpClient.js";

class ProbeClient extends OrchestratorHttpClient {
  write(path: string, body?: unknown) {
    return this.sendJson("POST", path, body);
  }

  writeExpectingBody(path: string, body?: unknown) {
    return this.sendJson<{ value: string }>("POST", path, body, {
      expectBody: true,
      decode: (value) =>
        typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string"
          ? { value: (value as { value: string }).value }
          : undefined,
    });
  }
}

type FetchFn = typeof fetch;

describe("OrchestratorHttpClient CSRF headers", () => {
  it("includes x-csrf-token on writes when csrfToken is set", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new ProbeClient({
      orchestratorUrl: "http://orch",
      cookieHeader: "tanren_session=abc",
      csrfToken: "csrf-secret",
      fetchImpl,
    });
    await client.write("/orgs/o1/thing", { a: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-secret");
    expect(headers["cookie"]).toBe("tanren_session=abc");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("omits x-csrf-token when csrfToken is unset (local-dev actor)", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new ProbeClient({
      orchestratorUrl: "http://orch",
      cookieHeader: undefined,
      fetchImpl,
    });
    await client.write("/orgs/o1/thing", { a: 1 });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBeUndefined();
  });

  it("omits x-csrf-token when csrfToken is empty string", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new ProbeClient({
      orchestratorUrl: "http://orch",
      csrfToken: "",
      fetchImpl,
    });
    await client.write("/orgs/o1/thing");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBeUndefined();
  });

  it("fails a typed write when a 2xx response has no JSON body", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(null, { status: 204 }));
    const client = new ProbeClient({
      orchestratorUrl: "http://orch",
      fetchImpl,
    });
    const result = await client.writeExpectingBody("/orgs/o1/thing");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();
  });

  it.each([{}, null])("fails a typed write when a 2xx JSON body has the wrong shape: %j", async (body) => {
    const fetchImpl = vi.fn<FetchFn>(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = new ProbeClient({ orchestratorUrl: "http://orch", fetchImpl });
    const result = await client.writeExpectingBody("/orgs/o1/thing");
    expect(result).toEqual({ ok: false, status: 200, body: undefined });
  });

  it("allows a no-body success when the caller does not require a body", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(null, { status: 204 }));
    const client = new ProbeClient({
      orchestratorUrl: "http://orch",
      fetchImpl,
    });
    const result = await client.write("/orgs/o1/thing");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();
  });
});

describe("invokeForgeTool CSRF (no sendJson bypass)", () => {
  it("forwards x-csrf-token on POST /forge/tools", async () => {
    const { OrchestratorClient } = await import("../src/api/orchestrator.js");
    const fetchImpl = vi.fn<FetchFn>(
      async () => new Response(JSON.stringify({ tool: "t", result: {} }), { status: 200 }),
    );
    const client = new OrchestratorClient({
      orchestratorUrl: "http://orch",
      csrfToken: "csrf-secret",
      fetchImpl,
    });
    await client.invokeForgeTool("org_a", "tanren.create_spec", { projectId: "p" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/orgs/org_a/forge/tools");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-secret");
  });
});

describe("brownfield-link response boundary", () => {
  it.each([{}, null])("rejects malformed successful JSON instead of casting it: %j", async (body) => {
    const { OrchestratorClient } = await import("../src/api/orchestrator.js");
    const client = new OrchestratorClient({
      orchestratorUrl: "http://orch",
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    });
    await expect(client.brownfieldLink("org_a", "project_a", { repoUrl: "https://github.com/a/b" })).resolves.toEqual({
      ok: false,
      status: 200,
    });
  });

  it("rejects an empty successful body", async () => {
    const { OrchestratorClient } = await import("../src/api/orchestrator.js");
    const client = new OrchestratorClient({
      orchestratorUrl: "http://orch",
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    await expect(client.brownfieldLink("org_a", "project_a", { repoUrl: "https://github.com/a/b" })).resolves.toEqual({
      ok: false,
      status: 200,
    });
  });
});
