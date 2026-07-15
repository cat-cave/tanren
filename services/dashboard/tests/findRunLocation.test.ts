// Production-path tests for OrchestratorClient.findRunLocation — the real
// client method, not a duplicate helper. Proves fail-closed decoding, multi-
// match, partial outage, and zero project/run-list fan-out.

import { describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "../src/api/orchestrator.js";
import {
  decodeRunLocation,
  isDefinitiveRunLocationNotFound,
  RUN_LOCATION_NOT_FOUND_BODY,
} from "../src/api/runLocation.js";

type FetchFn = typeof fetch;

const ORG_A = { id: "org_a", kind: "user", login: "a", displayName: "A", role: "org:member" };
const ORG_B = { id: "org_b", kind: "user", login: "b", displayName: "B", role: "org:member" };
const RUN_ID = "run_probe";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: FetchFn): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: "http://orch",
    cookieHeader: "tanren_session=s",
    fetchImpl,
  });
}

function requestedPaths(fetchImpl: ReturnType<typeof vi.fn<FetchFn>>): string[] {
  return fetchImpl.mock.calls.map(([input]) => {
    const url = typeof input === "string" ? input : input.toString();
    return url.replace("http://orch", "");
  });
}

describe("decodeRunLocation / not-found body", () => {
  it("accepts only exact { orgId, projectId } non-empty strings", () => {
    expect(decodeRunLocation({ orgId: "o", projectId: "p" })).toEqual({ orgId: "o", projectId: "p" });
    expect(decodeRunLocation({ orgId: "o", projectId: "p", extra: true })).toBeUndefined();
    expect(decodeRunLocation({ orgId: "", projectId: "p" })).toBeUndefined();
    expect(decodeRunLocation({ projectId: "p" })).toBeUndefined();
    expect(decodeRunLocation(null)).toBeUndefined();
    expect(decodeRunLocation("x")).toBeUndefined();
  });

  it("accepts only the exact documented 404 body", () => {
    expect(isDefinitiveRunLocationNotFound(RUN_LOCATION_NOT_FOUND_BODY)).toBe(true);
    expect(isDefinitiveRunLocationNotFound({ error: "run_not_found", extra: 1 })).toBe(false);
    expect(isDefinitiveRunLocationNotFound({ error: "other" })).toBe(false);
    expect(isDefinitiveRunLocationNotFound({})).toBe(false);
  });
});

describe("OrchestratorClient.findRunLocation (production path)", () => {
  it("returns found for a single definitive match and never fans out to projects/runs", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A, ORG_B] });
      if (url.endsWith(`/orgs/org_a/runs/${RUN_ID}/location`)) {
        return json({ orgId: "org_a", projectId: "project_a" });
      }
      if (url.endsWith(`/orgs/org_b/runs/${RUN_ID}/location`)) {
        return json(RUN_LOCATION_NOT_FOUND_BODY, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await client(fetchImpl).findRunLocation(RUN_ID);
    expect(result).toEqual({ kind: "found", location: { orgId: "org_a", projectId: "project_a" } });

    const paths = requestedPaths(fetchImpl);
    expect(paths).toEqual(["/orgs", `/orgs/org_a/runs/${RUN_ID}/location`, `/orgs/org_b/runs/${RUN_ID}/location`]);
    expect(paths.some((p) => p.includes("/projects"))).toBe(false);
    expect(paths.some((p) => /\/projects\/[^/]+\/runs$/u.test(p))).toBe(false);
  });

  it("returns not_found only when every probe is a definitive 404 body", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A, ORG_B] });
      if (url.includes("/location")) return json(RUN_LOCATION_NOT_FOUND_BODY, 404);
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({ kind: "not_found" });
  });

  it("fails closed on multi-match instead of picking the first org", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A, ORG_B] });
      if (url.endsWith(`/orgs/org_a/runs/${RUN_ID}/location`)) {
        return json({ orgId: "org_a", projectId: "project_a" });
      }
      if (url.endsWith(`/orgs/org_b/runs/${RUN_ID}/location`)) {
        return json({ orgId: "org_b", projectId: "project_b" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "ambiguous",
    });
  });

  it("fails closed on partial outage even when one org matched", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A, ORG_B] });
      if (url.endsWith(`/orgs/org_a/runs/${RUN_ID}/location`)) {
        return json({ orgId: "org_a", projectId: "project_a" });
      }
      if (url.endsWith(`/orgs/org_b/runs/${RUN_ID}/location`)) {
        return json({ error: "internal" }, 503);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "ambiguous",
    });
  });

  it("treats network/abort as unavailable, never not_found", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A] });
      throw new DOMException("aborted", "AbortError");
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream",
    });
  });

  it("surfaces 401/403 as auth", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A] });
      return json({ error: "org_access_denied" }, 403);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "auth",
      status: 403,
    });
  });

  it("fails closed on 5xx", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A] });
      return json({ error: "boom" }, 500);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream",
    });
  });

  it("fails closed on invalid 404 body", async () => {
    const fetchImpl = vi.fn<FetchFn>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/orgs")) return json({ orgs: [ORG_A] });
      return json({ error: "nope" }, 404);
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream",
    });
  });

  it("rejects malformed, extra-field, and wrong-domain 200 bodies", async () => {
    const cases: Array<{ body: unknown; status?: number }> = [
      { body: { orgId: "org_a", projectId: "p", extra: true } },
      { body: { orgId: "org_other", projectId: "p" } },
      { body: { projectId: "p" } },
      { body: "not-json-object" },
      { body: { orgId: "org_a", projectId: "p" }, status: 201 },
    ];
    for (const c of cases) {
      const fetchImpl = vi.fn<FetchFn>(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/orgs")) return json({ orgs: [ORG_A] });
        return json(c.body, c.status ?? 200);
      });
      const result = await client(fetchImpl).findRunLocation(RUN_ID);
      expect(result.kind).toBe("unavailable");
    }
  });

  it("fails closed when the orgs list itself is unreachable", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => {
      throw new TypeError("network down");
    });
    await expect(client(fetchImpl).findRunLocation(RUN_ID)).resolves.toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });
});
