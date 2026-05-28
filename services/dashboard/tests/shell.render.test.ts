// P2B-0001 shell verification harness — `app.request`-based rendered-HTML
// assertions. Mirrors the orchestrator contract-test pattern
// (services/orchestrator/tests/runRoutes.contract.test.ts): build the app with
// a stubbed pool + a mocked orchestrator (global fetch), then assert the
// rendered shell HTML. No live orchestrator and no DB are required.
//
// Coverage (the acceptance-criteria checklist for shell-and-palette.md):
//   - all four sidenav groups render;
//   - non-Phase-2 rows carry their `phase 3+` placeholder label;
//   - TopBar elements present (brand, org pill, ink/ash toggle, ⌘K, bell, avatar);
//   - palette markup present + sourced from the Forge tool surface groups;
//   - ink/ash data-theme wiring present;
//   - org + projects come from the orchestrator API and populate the chrome;
//   - unauthenticated requests redirect to the OAuth login (with `next`).

import type pg from "pg";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";
import { loadShellContext, renderShell, type ShellDeps } from "../src/app/mountShell.js";
import { SCREEN_MOUNTS } from "../src/app/screens.js";

const ORG = { id: "org_acme", kind: "github_org", login: "cat-cave", displayName: "Cat Cave", role: "org:admin" };
const PROJECTS = [
  {
    projectId: "project_easy",
    name: "tanren-fixture-easy",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker"
  }
];

/** Minimal pg.Pool stub — only `query("SELECT 1 AS ok")` is exercised (healthz). */
function stubPool(): pg.Pool {
  return {
    query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 })
  } as unknown as pg.Pool;
}

/** Install a global fetch mock emulating the orchestrator product APIs. */
function mockOrchestrator(opts: { authed: boolean } = { authed: true }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return opts.authed
        ? new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 })
        : new Response("unauthorized", { status: 401 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: opts.authed ? [ORG] : [] }), { status: 200 });
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
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

describe("dashboard shell rendering", () => {
  it("renders the four sidenav groups", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    expect(html).toContain("▮ org");
    expect(html).toContain("▮ projects");
    expect(html).toContain("▮ set up");
    expect(html).toContain("▮ onboarding");
  });

  it("labels non-Phase-2 rows as phase 3+ placeholders", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    // roadmap/personas/DORA/overview/discovery are phase 3+.
    expect(html).toContain("roadmap");
    expect(html).toMatch(/roadmap[\s\S]*?phase 3\+/);
    expect((html.match(/phase 3\+/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("renders the TopBar chrome elements", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="org-pill"');
    expect(html).toContain('data-island="theme-toggle"');
    expect(html).toContain('data-theme-value="ink"');
    expect(html).toContain('data-theme-value="ash"');
    expect(html).toContain("ask forge");
    expect(html).toContain("⌘K");
    expect(html).toContain('title="notifications"');
    expect(html).toContain('class="avatar"');
  });

  it("renders the palette markup sourced from the Forge tool surface", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    expect(html).toContain('data-island="palette"');
    expect(html).toContain("▮ quick actions");
    expect(html).toContain("▮ forge this");
    expect(html).toContain("▮ ask forge");
    // forge-this items are write actions wired to declared Forge tools.
    expect(html).toContain('data-tool="tanren.create_spec"');
  });

  it("wires the ink/ash data-theme and loads the client bundle", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    // default surface is ink → data-theme="dark"
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('href="/static/tokens.css"');
    expect(html).toContain('src="/static/client.js"');
  });

  it("populates org + projects in the chrome from the orchestrator API", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    expect(html).toContain("Cat Cave");
    expect(html).toContain("tanren-fixture-easy");
    expect(html).toContain('href="/projects/project_easy"');
  });

  it("sets the project crumb on a project-scoped route", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain('class="proj-crumb"');
    expect(html).toContain("tanren-fixture-easy");
  });

  it("renders a documented placeholder for a phase-3 sidenav row", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/roadmap")).text();
    expect(html).toContain("placeholder");
    expect(html).toContain("Phase 3");
  });
});

describe("dashboard auth flow", () => {
  it("redirects unauthenticated requests to the orchestrator OAuth login", async () => {
    process.env.TANREN_REQUIRE_AUTH = "1";
    mockOrchestrator({ authed: false });
    const app = await build();
    const res = await app.request("/projects");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login?next=%2Fprojects");
  });

  it("login redirect points at the github_oauth provider with a next param", async () => {
    process.env.TANREN_REQUIRE_AUTH = "1";
    mockOrchestrator({ authed: false });
    const app = await build();
    const res = await app.request("/auth/login?next=/projects");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("provider=github_oauth");
    expect(location).toContain("next=%2Fprojects");
  });
});

// Regression guard for the whole fan-out: a child screen registered at a
// placeholder path (via the append-only SCREEN_MOUNTS registry) must win, and
// the shell must NOT shadow it with a placeholder.
describe("screen-router mounting convention (fan-out extension point)", () => {
  // Isolate the registry: real child screens (e.g. P2B-0005's mountCostsScreen)
  // self-register at module load, so reset before each case to exercise ONLY
  // the fake mount this block pushes. The /costs example path is now a real
  // route, so without this reset the real screen would shadow the fake one.
  let savedMounts: typeof SCREEN_MOUNTS = [];
  beforeEach(() => {
    savedMounts = SCREEN_MOUNTS.splice(0, SCREEN_MOUNTS.length);
  });
  afterEach(() => {
    SCREEN_MOUNTS.length = 0;
    SCREEN_MOUNTS.push(...savedMounts);
  });

  it("renders a registered child route at a placeholder path instead of the placeholder", async () => {
    mockOrchestrator();
    SCREEN_MOUNTS.push((app: Hono, deps: ShellDeps) => {
      app.get("/costs", async (c) => {
        const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
        return renderShell(c, ctx, { title: "tanren · costs" }, "REAL_COSTS_SCREEN");
      });
    });
    const app = await build();
    const html = await (await app.request("/costs")).text();
    expect(html).toContain("REAL_COSTS_SCREEN");
    expect(html).not.toContain("documented placeholder");
  });

  it("still serves the placeholder for rows no child screen claims", async () => {
    mockOrchestrator();
    SCREEN_MOUNTS.push((app: Hono, deps: ShellDeps) => {
      app.get("/costs", async (c) => {
        const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
        return renderShell(c, ctx, { title: "tanren · costs" }, "REAL_COSTS_SCREEN");
      });
    });
    const app = await build();
    const html = await (await app.request("/notifications")).text();
    expect(html).toContain("documented placeholder");
  });
});
