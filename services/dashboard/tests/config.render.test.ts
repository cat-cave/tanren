// P3-0017 tanren-config audit-gate surface render tests. Mirrors the DORA
// harness: build the app with a stubbed pool + a mocked orchestrator (global
// fetch), then assert the rendered /settings/config screen in both states.
//
// Coverage:
//   - /settings/config overrides the placeholder (real config-as-code screen);
//   - gate OFF → intro card + enable CTA + dashboard-applied history;
//   - gate ON  → forge rationale + the tanren.yaml diff + checks + merge gate;
//   - the routing & limits settings reflects the org gate state + toggle.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECTS = [
  {
    projectId: "project_easy",
    name: "tanren-fixture-easy",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];

let gateEnabled = false;

function orgConfig(): unknown {
  return {
    version: 1,
    routing: {
      plan: { chain: [] },
      write: { chain: [] },
      check: { chain: [] },
      audit: { chain: [{ cli: "claude", model: "opus-4.7", authRef: "credential/x" }] },
      demo: { chain: [] },
      forge: { chain: [] },
    },
    escapeHatches: {
      maxWriterIterPerSubtask: 5,
      maxPlannerRerunsPerSpec: 3,
      maxRetriesPerTransientFailure: 3,
      maxSpecDiscoveryRoundsWithForge: 20,
    },
    auditGateEnabled: gateEnabled,
    ...(gateEnabled
      ? {
          auditGate: {
            repo: "cat-cave/tanren-config",
            baseBranch: "main",
            branchPrefix: "forge",
            configFile: "tanren.yaml",
          },
        }
      : {}),
  };
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith("/orgs/org_acme")) {
      return new Response(
        JSON.stringify({
          id: ORG.id,
          login: ORG.login,
          displayName: ORG.displayName,
          config: orgConfig(),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  gateEnabled = false;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("tanren-config audit-gate surface (/settings/config)", () => {
  it("overrides the placeholder with the real config-as-code screen", async () => {
    const app = await build();
    const html = await (await app.request("/settings/config")).text();
    expect(html).toContain("config as code");
    expect(html).not.toContain("documented placeholder");
  });

  it("gate OFF → renders the intro + enable CTA + dashboard-applied history", async () => {
    const app = await build();
    const html = await (await app.request("/settings/config")).text();
    expect(html).toContain("gate · off");
    expect(html).toContain("enable audit gate");
    expect(html).toContain("dashboard-applied");
  });

  it("gate ON → renders the merge gate + tanren.yaml + checks", async () => {
    gateEnabled = true;
    const app = await build();
    const html = await (
      await app.request(
        "/settings/config?pr=7&prUrl=https://github.com/cat-cave/tanren-config/pull/7&branch=forge/route",
      )
    ).text();
    expect(html).toContain("review the config change");
    expect(html).toContain("tanren.yaml");
    expect(html).toContain("schema valid");
    expect(html).toContain("merging applies the routing change to every new run");
    expect(html).toContain("approve · merge config");
    // The opened PR is linked.
    expect(html).toContain("/cat-cave/tanren-config/pull/7");
  });

  it("gate ON without an open PR → invites proposing a change", async () => {
    gateEnabled = true;
    const app = await build();
    const html = await (await app.request("/settings/config")).text();
    expect(html).toContain("gate · on");
    expect(html).toContain("propose a change");
  });

  it("routing & limits surfaces the org gate state + a toggle form", async () => {
    gateEnabled = true;
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect(html).toContain("cat-cave/tanren-config");
    expect(html).toContain("disable audit gate");
    expect(html).toContain('action="/settings/config/toggle"');
  });
});
