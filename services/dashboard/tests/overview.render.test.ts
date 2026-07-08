// Org Overview command deck rendered-HTML tests. Mirrors the merge-queue /
// budget harness: stubbed pool + mocked orchestrator (global fetch), assert
// the rendered /overview screen.
//
// Coverage:
//   - /overview mounts the real screen (not a placeholder);
//   - projects grid from listProjects;
//   - budget MTD from org + project budget endpoints;
//   - sparse / uncomputable figures render "—", never fabricated zeros;
//   - read failure → unavailable / empty (not fabricated data);
//   - activity feed merges project feeds;
//   - forge-org card is honest unavailable (no stub engine).

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
  {
    projectId: "project_supply",
    name: "supply-chain-os",
    repoUrl: "https://github.com/cat-cave/supply-chain-os",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];

const ORG_BUDGET = {
  ceilingUsd: 275,
  period: "monthly",
};

const PROJECT_BUDGET_EASY = {
  ceilingUsd: 50,
  period: "monthly",
  spentUsd: 12.34,
  notionalUsd: 40.5,
  remainingUsd: 37.66,
  paused: false,
  failClosed: null,
};

const PROJECT_BUDGET_SUPPLY = {
  ceilingUsd: 200,
  period: "monthly",
  spentUsd: 71.86,
  notionalUsd: 80,
  remainingUsd: 128.14,
  paused: false,
  failClosed: null,
};

const FEED_EASY = {
  items: [
    {
      id: 1,
      eventType: "run.merged",
      payload: {},
      projectId: "project_easy",
      redactedPaths: [],
      runId: "run_1",
      specId: "spec_a",
      taskId: null,
      ts: "2026-05-28T12:00:00.000Z",
    },
    {
      id: 2,
      eventType: "writer.subtask.started",
      payload: {},
      projectId: "project_easy",
      redactedPaths: [],
      runId: "run_2",
      specId: null,
      taskId: "task_1",
      ts: "2026-05-28T12:10:00.000Z",
    },
  ],
};

const FEED_SUPPLY = {
  items: [
    {
      id: 3,
      eventType: "interview.personas.captured",
      payload: {},
      projectId: "project_supply",
      redactedPaths: [],
      runId: "run_3",
      specId: null,
      taskId: null,
      ts: "2026-05-28T11:30:00.000Z",
    },
  ],
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let projectsPayload: unknown[] = PROJECTS;
let orgBudgetPayload: unknown = ORG_BUDGET;
let projectBudgets: Record<string, unknown> = {
  project_easy: PROJECT_BUDGET_EASY,
  project_supply: PROJECT_BUDGET_SUPPLY,
};
let feeds: Record<string, unknown> = {
  project_easy: FEED_EASY,
  project_supply: FEED_SUPPLY,
};
let failOrgBudget = false;
let failProjectBudget = false;
let failFeed = false;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }

    // Project budget before generic /projects and org budget.
    const projectBudgetMatch = /\/projects\/([^/]+)\/budget(\?|$)/u.exec(url);
    if (projectBudgetMatch !== null) {
      if (failProjectBudget) return new Response("boom", { status: 500 });
      const pid = projectBudgetMatch[1] ?? "";
      const body = projectBudgets[pid];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }

    const feedMatch = /\/projects\/([^/]+)\/feed(\?|$)/u.exec(url);
    if (feedMatch !== null) {
      if (failFeed) return new Response("boom", { status: 500 });
      const pid = feedMatch[1] ?? "";
      const body = feeds[pid];
      if (body === undefined) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify(body), { status: 200 });
    }

    if (/\/orgs\/[^/]+\/budget(\?|$)/u.test(url)) {
      if (failOrgBudget) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(orgBudgetPayload), { status: 200 });
    }

    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: projectsPayload }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  projectsPayload = PROJECTS;
  orgBudgetPayload = ORG_BUDGET;
  projectBudgets = {
    project_easy: PROJECT_BUDGET_EASY,
    project_supply: PROJECT_BUDGET_SUPPLY,
  };
  feeds = {
    project_easy: FEED_EASY,
    project_supply: FEED_SUPPLY,
  };
  failOrgBudget = false;
  failProjectBudget = false;
  failFeed = false;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("org overview command deck (/overview)", () => {
  it("mounts the real screen, not a placeholder", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("command deck");
    expect(html).not.toContain("documented placeholder");
    expect(html).toContain('data-screen="overview"');
  });

  it("renders the projects grid from listProjects", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("projects ·");
    expect(html).toContain("the portfolio");
    expect(html).toContain("tanren-fixture-easy");
    expect(html).toContain("supply-chain-os");
    expect(html).toContain('data-project-id="project_easy"');
    expect(html).toContain('href="/projects/project_easy"');
    expect(html).toContain("https://github.com/cat-cave/tanren-fixture-easy");
  });

  it("renders gated spend vs sum of project ceilings (not org default as portfolio cap)", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    // 12.34 + 71.86 = 84.20 spend
    expect(html).toContain("$84.20");
    // Project ceilings 50 + 200 = 250 (NOT org default 275)
    expect(html).toContain("$250.00");
    expect(html).toContain("gated spend");
    expect(html).toContain("project ceilings");
    // 84.20 / 250 ≈ 34%
    expect(html).toContain("34%");
    expect(html).toContain("2 projects summed");
    // Org default is shown as inheritance context, not as the portfolio denominator.
    expect(html).toContain("$275.00");
    expect(html).toContain("inheritance only");
  });

  it("renders em-dash for uncomputable spend, never fabricated $0.00", async () => {
    projectBudgets = {
      project_easy: {
        ceilingUsd: null,
        period: "monthly",
        spentUsd: 0,
        notionalUsd: 0,
        remainingUsd: null,
        paused: false,
        failClosed: null,
      },
      project_supply: {
        ceilingUsd: null,
        period: "monthly",
        spentUsd: 0,
        notionalUsd: 0,
        remainingUsd: null,
        paused: false,
        failClosed: null,
      },
    };
    orgBudgetPayload = { ceilingUsd: null, period: "monthly" };
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("—");
    expect(html).toContain("no computable project spend");
    // Must not claim measured $0.00 for skipped-sum placeholders.
    expect(html).not.toContain("$0.00");
  });

  it("renders budget unavailable when org + all project budget reads fail", async () => {
    failOrgBudget = true;
    failProjectBudget = true;
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("Budget unavailable");
    expect(html).toContain("data-budget-unavailable");
    expect(html).not.toContain("$12.34");
    expect(html).not.toContain("$84.20");
  });

  it("renders the activity feed merged across projects, newest first", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("activity ·");
    expect(html).toContain("cross-project");
    expect(html).toContain("tanren-fixture-easy");
    expect(html).toContain("supply-chain-os");
    expect(html).toContain("run merged");
    expect(html).toContain("writer subtask started");
    expect(html).toContain("interview personas captured");
    // Newest feed item links to the mounted run-detail route.
    expect(html).toContain('href="/runs/run_2"');
  });

  it("renders activity unavailable when every project feed read fails", async () => {
    failFeed = true;
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("Activity unavailable");
    expect(html).toContain("data-activity-unavailable");
    expect(html).not.toContain("run merged");
  });

  it("surfaces partial feed failure when some project feeds fail", async () => {
    // Fail only supply-chain feed via URL-specific handling: replace feeds
    // map so supply is missing and use a custom fetch that 500s that path.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
          status: 200,
        });
      }
      if (url.endsWith("/orgs")) {
        return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      }
      const projectBudgetMatch = /\/projects\/([^/]+)\/budget(\?|$)/u.exec(url);
      if (projectBudgetMatch !== null) {
        const pid = projectBudgetMatch[1] ?? "";
        return new Response(JSON.stringify(projectBudgets[pid]), { status: 200 });
      }
      if (/\/projects\/project_supply\/feed/u.test(url)) {
        return new Response("boom", { status: 500 });
      }
      if (/\/projects\/project_easy\/feed/u.test(url)) {
        return new Response(JSON.stringify(FEED_EASY), { status: 200 });
      }
      if (/\/orgs\/[^/]+\/budget(\?|$)/u.test(url)) {
        return new Response(JSON.stringify(orgBudgetPayload), { status: 200 });
      }
      if (url.includes("/projects")) {
        return new Response(JSON.stringify({ projects: projectsPayload }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/overview")).text();
    // Successful feed still renders.
    expect(html).toContain("run merged");
    // Partial failure is not silent.
    expect(html).toContain("data-activity-partial");
    expect(html).toContain("project feed");
    expect(html).toContain("omitted");
  });

  it("labels mixed budget periods instead of claiming month-to-date", async () => {
    projectBudgets = {
      project_easy: { ...PROJECT_BUDGET_EASY, period: "monthly" },
      project_supply: { ...PROJECT_BUDGET_SUPPLY, period: "quarterly" },
    };
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("mixed");
    expect(html).toContain("data-period-mixed");
    // Card title stays "gated spend", never claims a single MTD window.
    expect(html).toContain("gated spend");
    expect(html).not.toMatch(/budget · <em>month-to-date<\/em>/u);
  });

  it("renders empty projects state without inventing tiles", async () => {
    projectsPayload = [];
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("No projects yet");
    expect(html).toContain("data-projects-empty");
    expect(html).not.toContain("tanren-fixture-easy");
  });

  it("renders projects unavailable when the projects list read fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
          status: 200,
        });
      }
      if (url.endsWith("/orgs")) {
        return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      }
      // Projects list fails (not an empty success body).
      if (/\/orgs\/[^/]+\/projects(\?|$)/u.test(url)) {
        return new Response("boom", { status: 500 });
      }
      if (/\/orgs\/[^/]+\/budget(\?|$)/u.test(url)) {
        return new Response(JSON.stringify(orgBudgetPayload), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("Projects unavailable");
    expect(html).toContain("data-projects-unavailable");
    expect(html).not.toContain("No projects yet");
    expect(html).not.toContain("tanren-fixture-easy");
  });

  it("renders forge-org as honest unavailable, not a stub engine", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("forge ·");
    expect(html).toContain("org-wide");
    expect(html).toContain("data-forge-unavailable");
    expect(html).toContain("not wired yet");
    // No fake prompt chips that pretend to answer.
    expect(html).not.toContain("which project will hit budget first");
  });

  it("shows pause note when a project budget is paused", async () => {
    projectBudgets = {
      ...projectBudgets,
      project_easy: { ...PROJECT_BUDGET_EASY, paused: true, spentUsd: 50, remainingUsd: 0 },
    };
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain("halted on budget");
  });
});
