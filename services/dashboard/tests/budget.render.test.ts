// Budget-halt panel rendered-HTML tests. Mirrors the merge-queue / DORA
// harness: build the app with a stubbed pool + a mocked orchestrator (global
// fetch), then assert the rendered /budget screen.
//
// Coverage:
//   - /budget mounts the real screen (not a placeholder);
//   - full-data: ceiling, period, real spend, notional, remaining;
//   - sparse/null ceiling + remaining → "—", never fabricated zeros for missing;
//   - read-failure → "unavailable" (not zeros);
//   - paused banner when paused:true;
//   - config form renders (save + clear).

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

const PROJECT_BUDGET_FULL = {
  ceilingUsd: 50,
  period: "monthly",
  spentUsd: 12.34,
  notionalUsd: 40.5,
  remainingUsd: 37.66,
  paused: false,
  pauseObservation: null,
  failClosed: null,
};

const PROJECT_BUDGET_SPARSE = {
  ceilingUsd: null,
  period: "monthly",
  spentUsd: 0,
  notionalUsd: 0,
  remainingUsd: null,
  paused: false,
  pauseObservation: null,
  failClosed: null,
};

const PROJECT_BUDGET_PAUSED = {
  ...PROJECT_BUDGET_FULL,
  spentUsd: 50,
  remainingUsd: 0,
  paused: true,
  pauseObservation: {
    eventType: "dag.budget.paused",
    readyHeldBack: 2,
    observedAt: "2026-07-15T13:14:15.000Z",
  },
  failClosed: null,
};

const ORG_BUDGET = {
  ceilingUsd: 100,
  period: "monthly",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let projectBudgetPayload: unknown = PROJECT_BUDGET_FULL;
let orgBudgetPayload: unknown = ORG_BUDGET;
let failProjectRead = false;
let failOrgRead = false;
let lastPutBody: unknown;
let lastPutHeaders: Record<string, string> | undefined;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }

    // Project budget MUST match before org budget and the generic /projects fallback
    // (paths contain both "/projects" and "/budget").
    if (/\/projects\/[^/]+\/budget(\?|$)/u.test(url)) {
      if (method === "PUT") {
        lastPutBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        lastPutHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify(projectBudgetPayload), { status: 200 });
      }
      if (failProjectRead) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(projectBudgetPayload), { status: 200 });
    }
    if (/\/orgs\/[^/]+\/budget(\?|$)/u.test(url)) {
      if (failOrgRead) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(orgBudgetPayload), { status: 200 });
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  projectBudgetPayload = PROJECT_BUDGET_FULL;
  orgBudgetPayload = ORG_BUDGET;
  failProjectRead = false;
  failOrgRead = false;
  lastPutBody = undefined;
  lastPutHeaders = undefined;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("budget-halt panel (/budget)", () => {
  it("mounts the real screen, not a placeholder", async () => {
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("budget &amp; spend gate");
    expect(html).not.toContain("documented placeholder");
  });

  it("renders full-data ceiling, real spend, notional, and remaining", async () => {
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("ceiling");
    expect(html).toContain("real spend");
    expect(html).toContain("notional");
    expect(html).toContain("remaining");
    expect(html).toContain("$50.00");
    expect(html).toContain("$12.34");
    expect(html).toContain("$40.50");
    expect(html).toContain("$37.66");
    // Doctrine labels: real is gated; notional is not.
    expect(html).toContain("gated figure");
    expect(html).toContain("not gated");
    expect(html).toContain("monthly");
  });

  it("renders em-dash for null ceiling and skipped-sum spend placeholders, never $0.00", async () => {
    projectBudgetPayload = PROJECT_BUDGET_SPARSE;
    const app = await build();
    const html = await (await app.request("/budget")).text();
    // Unlimited / no ceiling: gate skips the sum → spent/notional placeholders must
    // render "—", not fabricated $0.00.
    expect(html).toContain("—");
    expect(html).toContain("no ceiling · spend not summed by the gate");
    expect(html).not.toContain("$0.00");
    expect(html).toMatch(/ceiling[\s\S]*?value empty[\s\S]*?—/u);
  });

  it("renders genuine zero spend as $0.00 when a ceiling is set and the sum ran", async () => {
    projectBudgetPayload = {
      ceilingUsd: 50,
      period: "monthly",
      spentUsd: 0,
      notionalUsd: 0,
      remainingUsd: 50,
      paused: false,
      failClosed: null,
    };
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("$50.00");
    expect(html).toContain("$0.00");
    expect(html).toContain("gated figure · cost_usd billed");
  });

  it("renders 'unavailable', not fabricated zeros, when the project budget read fails", async () => {
    failProjectRead = true;
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("Budget unavailable");
    // Failed read must not paint the spend grid figures as zeros.
    expect(html).not.toContain("gated figure · cost_usd billed");
    expect(html).not.toContain("$12.34");
  });

  it("shows the halted-on-budget banner when paused is true", async () => {
    projectBudgetPayload = PROJECT_BUDGET_PAUSED;
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("halted on budget");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Latest walker proof");
    expect(html).toContain("2</b> eligible ready specs held");
    expect(html).toContain("2026-07-15T13:14:15.000Z");
  });

  it("shows proof pending instead of a fabricated zero before the walker event lands", async () => {
    projectBudgetPayload = { ...PROJECT_BUDGET_PAUSED, pauseObservation: null };
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("Walker pause proof pending");
    expect(html).not.toContain("0</b> eligible ready specs held");
  });

  it("does not show the halt banner when paused is false", async () => {
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).not.toContain("halted on budget");
  });

  it("renders fail-closed pause with — for unmeasured spend, not $0.00", async () => {
    // Backend fail-closed placeholders: unresolvable + spent/notional 0.
    projectBudgetPayload = {
      ceilingUsd: null,
      period: "monthly",
      spentUsd: 0,
      notionalUsd: 0,
      remainingUsd: null,
      paused: true,
      pauseObservation: null,
      failClosed: "unresolvable_project_org",
    };
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("halted on budget");
    expect(html).toContain("Fail-closed safety pause");
    expect(html).toContain("unmeasured · fail-closed safety pause");
    // Real-spend / notional cards must not claim $0.00 for fail-closed placeholders.
    expect(html).not.toContain("gated figure · cost_usd billed");
    expect(html).not.toContain("$0.00");
  });

  it("renders unpriced_spend fail-closed even when partial spent ≥ ceiling as unmeasured", async () => {
    // Explicit failClosed: partial sum may already meet the ceiling but true spend is unknown.
    projectBudgetPayload = {
      ceilingUsd: 50,
      period: "monthly",
      spentUsd: 50,
      notionalUsd: 60,
      remainingUsd: 0,
      paused: true,
      pauseObservation: null,
      failClosed: "unpriced_spend",
    };
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("halted on budget");
    expect(html).toContain("Fail-closed safety pause");
    expect(html).toContain("unmeasured · fail-closed safety pause");
    // Ceiling is still shown; spend/notional/remaining go to "—".
    expect(html).toContain("$50.00");
    expect(html).not.toContain("gated figure · cost_usd billed");
    expect(html).not.toContain("$60.00");
  });

  it("POST without projectId rejects without writing", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=save&ceilingUsd=10&period=monthly",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("err=no_project");
    expect(lastPutBody).toBeUndefined();
  });

  it("renders the config form with save and clear controls and scoped projectId", async () => {
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain('action="/budget"');
    expect(html).toContain('name="ceilingUsd"');
    expect(html).toContain('name="period"');
    expect(html).toContain('name="projectId"');
    expect(html).toContain('value="project_easy"');
    expect(html).toContain('value="save"');
    expect(html).toContain('value="clear"');
    expect(html).toContain("configure project ceiling");
    // Org default shown for context.
    expect(html).toContain("Org default budget");
    expect(html).toContain("$100.00");
  });

  it("POST save proxies PUT with ceiling + period to the orchestrator", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=save&ceilingUsd=75&period=quarterly&projectId=project_easy",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("ok=saved");
    expect(res.headers.get("location")).toContain("projectId=project_easy");
    expect(lastPutBody).toEqual({ ceilingUsd: 75, period: "quarterly" });
    // Session CSRF from /auth/me must ride along for state-changing writes.
    expect(lastPutHeaders?.["x-csrf-token"]).toBe("c");
  });

  it("POST clear proxies PUT with ceilingUsd null", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=clear&projectId=project_easy",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("ok=cleared");
    expect(lastPutBody).toEqual({ ceilingUsd: null });
  });

  it("POST rejects an unknown projectId without writing", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=save&ceilingUsd=10&period=monthly&projectId=project_other",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("err=no_project");
    expect(lastPutBody).toBeUndefined();
  });

  it("shows org-default unavailable when the org budget read fails", async () => {
    failOrgRead = true;
    const app = await build();
    const html = await (await app.request("/budget")).text();
    expect(html).toContain("Org default budget: unavailable");
  });
});
