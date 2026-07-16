// Former-bug proofs: every listRunsMaybe consumer distinguishes unavailable
// from empty — no false all-clear / no-runs / start-from-empty claims.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = { id: "org_acme", kind: "github_org", login: "acme", displayName: "Acme", role: "org:admin" };
const PROJECT = {
  projectId: "project_1",
  name: "one",
  repoUrl: "https://github.com/acme/one",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

const SPEC = {
  specId: "spec_1",
  projectId: "project_1",
  title: "Spec One",
  description: "d",
  acceptanceCriteria: ["a"],
  dependsOn: [],
  status: "ready",
  priority: "P1",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function baseFetch(handlers: (url: string, method: string) => Response | null): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const handled = handlers(url, method);
    if (handled !== null) return handled;
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (/\/projects\/[^/]+\/insights/u.test(url))
      return new Response(JSON.stringify({ insights: [] }), { status: 200 });
    if (/\/projects\/[^/]+\/milestones/u.test(url))
      return new Response(JSON.stringify({ milestones: [] }), { status: 200 });
    if (/\/projects\/[^/]+\/feed/u.test(url)) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (/\/projects\/[^/]+\/specs$/u.test(url)) return new Response(JSON.stringify({ specs: [SPEC] }), { status: 200 });
    if (/\/projects\/[^/]+\/personas/u.test(url))
      return new Response(JSON.stringify({ personas: [] }), { status: 200 });
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("listRunsMaybe unavailable consumers", () => {
  it("project main view suppresses all-clear and no-runs claims on failure", async () => {
    baseFetch((url) => {
      if (/\/projects\/[^/]+\/runs(?:\?|$)/u.test(url)) return new Response("down", { status: 503 });
      return null;
    });
    const html = await (await (await build()).request("/projects/project_1")).text();
    expect(html).toContain("data-runs-unavailable");
    expect(html).toContain("data-attention-unavailable");
    expect(html).toContain("data-dag-unavailable");
    expect(html).not.toContain("Nothing needs you right now");
    expect(html).not.toContain("No runs yet");
  });

  it("project spec list suppresses no-runs and start-a-run on failure", async () => {
    baseFetch((url) => {
      if (/\/projects\/[^/]+\/runs(?:\?|$)/u.test(url)) return new Response("down", { status: 503 });
      return null;
    });
    const html = await (await (await build()).request("/projects/project_1/specs")).text();
    expect(html).toContain("data-runs-unavailable");
    expect(html).toContain("runs unavailable");
    expect(html).not.toContain("no runs");
    expect(html).not.toContain("▶ start a run");
  });

  it("halted aggregate is unavailable when any constituent fails", async () => {
    baseFetch((url) => {
      if (/\/projects\/[^/]+\/runs(?:\?|$)/u.test(url)) return new Response("down", { status: 503 });
      return null;
    });
    const html = await (await (await build()).request("/runs/halted")).text();
    expect(html).toContain("data-halted-unavailable");
    expect(html).not.toContain("No halted runs. Everything is moving");
    expect(html).not.toContain("Everything is moving");
  });

  it("spec detail model suppresses forge affordance when runs are unavailable", async () => {
    // Pure model proof (route may 404 without a full mock matrix).
    const { buildSpecDetail } = await import("../src/components/project/specDetail.js");
    const detail = buildSpecDetail({
      spec: {
        specId: "spec_1",
        projectId: "project_1",
        title: "Spec One",
        description: "d",
        acceptanceCriteria: ["a"],
        dependsOn: ["dep_1"],
        status: "ready",
        priority: "P1",
      },
      allSpecs: [
        {
          specId: "dep_1",
          projectId: "project_1",
          title: "Dep",
          description: "",
          acceptanceCriteria: [],
          dependsOn: [],
          status: "ready",
          priority: "P1",
        },
      ],
      runs: [],
      statusBySpecId: new Map(),
      runsAvailable: false,
      depsRunsAvailable: false,
    });
    expect(detail.primaryAction).toBeNull();
    expect(detail.runsAvailable).toBe(false);
    expect(detail.dependsOn[0]?.status).toBe("unavailable");
    expect(detail.statusLabel).toBe("unavailable");
  });
});
