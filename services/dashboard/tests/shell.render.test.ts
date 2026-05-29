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

/** Minimal pg.Pool stub — only `query("SELECT 1 AS ok")` is exercised (healthz). */
function stubPool(): pg.Pool {
  return {
    query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }),
  } as unknown as pg.Pool;
}

/** Install a global fetch mock emulating the orchestrator product APIs. */
function mockOrchestrator(opts: { authed: boolean } = { authed: true }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return opts.authed
        ? new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
            status: 200,
          })
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
    // overview/roadmap/personas are phase 3+ (DORA shipped in P3-0019,
    // discovery in P3-0014).
    expect(html).toContain("roadmap");
    expect(html).toMatch(/roadmap[\s\S]*?phase 3\+/);
    expect((html.match(/phase 3\+/g) ?? []).length).toBeGreaterThanOrEqual(3);
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

  it("renders the P3-0010 thick-Forge chat morph scaffold", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/projects")).text();
    // The chat container + back button + chat footer are server-rendered
    // (hidden until the island morphs the palette into a thread).
    expect(html).toContain("data-palette-chat");
    expect(html).toContain("data-palette-back");
    expect(html).toContain("data-palette-footer-chat");
    expect(html).toContain("forge · chat");
    // ask-forge prompts (no route/tool) carry data-ask="1" so the island knows
    // to morph to chat rather than navigate.
    expect(html).toContain('data-ask="1"');
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

// DEV-ONLY: with the local_dev escape hatch on, /auth/login must NOT 302 the
// browser cross-origin to the docker-internal orchestrator (the original bug).
// It runs the handshake server-side and 303s to `next` with a session cookie.
function mockDevLoginOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/auth/login")) {
      const headers = new Headers();
      headers.set("location", "http://orchestrator:3100/auth/callback?provider=local_dev&state=st1&code=local-dev");
      headers.append("set-cookie", "tanren_oauth_state=st1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600");
      return new Response(null, { status: 302, headers });
    }
    if (url.includes("/auth/callback")) {
      const headers = new Headers();
      headers.append("set-cookie", "tanren_session=sess-1; Path=/; HttpOnly; SameSite=Lax");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("dashboard dev-login proxy (TANREN_DEV_LOGIN=1)", () => {
  afterEach(() => {
    delete process.env.TANREN_DEV_LOGIN;
  });

  it("303s to next with a re-emitted tanren_session cookie instead of a cross-origin redirect", async () => {
    process.env.TANREN_DEV_LOGIN = "1";
    mockDevLoginOrchestrator();
    const app = await build();
    const res = await app.request("/auth/login?next=/projects");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("tanren_session=sess-1");
    // Must NOT leak the internal orchestrator host to the browser.
    expect(setCookie).not.toContain("orchestrator:3100");
  });

  it("bounces back to /signin with an error when the handshake fails", async () => {
    process.env.TANREN_DEV_LOGIN = "1";
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const app = await build();
    const res = await app.request("/auth/login?next=/projects");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/signin");
    expect(location).toContain("error=dev_login_failed");
    expect(location).not.toContain("orchestrator:3100");
  });

  it("renders the sign-in error banner when /signin carries an error param", async () => {
    process.env.TANREN_DEV_LOGIN = "1";
    mockDevLoginOrchestrator();
    const app = await build();
    const html = await (await app.request("/signin?error=dev_login_failed")).text();
    expect(html).toContain('data-testid="signin-error"');
  });
});

// Regression guard for the whole fan-out: a child screen registered at a
// placeholder path (via the append-only SCREEN_MOUNTS registry) must win, and
// the shell must NOT shadow it with a placeholder.
//
// These tests deliberately probe a *permanently phase-3+* row (`/roadmap`,
// `/personas`) rather than a Phase-2B path. Phase-2B fan-out specs progressively
// turn their own rows (`/costs`, `/notifications`, `/projects`, …) into real
// screens, so probing those would make this guard fail the moment its owning
// spec lands. The phase-3+ rows stay placeholders for all of Phase 2B, keeping
// this regression test stable regardless of merge order.
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
      app.get("/roadmap", async (c) => {
        const ctx = await loadShellContext(c, deps, { activeNavId: "roadmap" });
        return renderShell(c, ctx, { title: "tanren · roadmap" }, "REAL_FANOUT_SCREEN");
      });
    });
    const app = await build();
    const html = await (await app.request("/roadmap")).text();
    expect(html).toContain("REAL_FANOUT_SCREEN");
    expect(html).not.toContain("documented placeholder");
  });

  it("still serves the placeholder for rows no child screen claims", async () => {
    mockOrchestrator();
    // Claiming one row must not shadow an unrelated unclaimed row.
    SCREEN_MOUNTS.push((app: Hono, deps: ShellDeps) => {
      app.get("/roadmap", async (c) => {
        const ctx = await loadShellContext(c, deps, { activeNavId: "roadmap" });
        return renderShell(c, ctx, { title: "tanren · roadmap" }, "REAL_FANOUT_SCREEN");
      });
    });
    const app = await build();
    const html = await (await app.request("/personas")).text();
    expect(html).toContain("documented placeholder");
  });
});
