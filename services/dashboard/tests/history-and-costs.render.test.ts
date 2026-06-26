// history & costs rendered-HTML tests. Mirrors the shell
// harness (tests/shell.render.test.ts): build the app with a stubbed pool +
// a mocked orchestrator (global fetch), then assert the rendered screens.
//
// Coverage (acceptance-criteria: docs/design/acceptance-criteria/history-and-costs.md):
//   - /costs overrides the placeholder (real screen, not "documented placeholder");
//   - all three pricing models render with their per-source cards;
//   - the provider breakdown table shows every row's REAL cost source;
//   - no fabricated unknown-source placeholder (honest "no $ basis" only);
//   - burn projection + headroom + observed panels render numbers;
//   - date-range filter pills + export-csv action present;
//   - /costs/export.csv emits a CSV with the real cost_basis per row;
//   - /history lists prior runs from the run-list read API.

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

const RUNS = [
  {
    runId: "run_a1",
    specId: "spec_1",
    projectId: "project_easy",
    branch: "tanren/run_a1",
    trigger: "operator",
    status: "succeeded",
    outcome: "ok",
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: "2026-05-28T10:21:00.000Z",
    prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/7",
    specTitle: "add health endpoint",
    costTotalUsd: "12.34",
    lastEventAt: "2026-05-28T10:21:00.000Z",
    needsReview: false,
  },
  {
    runId: "run_b2",
    specId: "spec_2",
    projectId: "project_easy",
    branch: "tanren/run_b2",
    trigger: "operator",
    status: "failed",
    outcome: "halted",
    startedAt: "2026-05-27T09:00:00.000Z",
    endedAt: "2026-05-27T09:40:00.000Z",
    prUrl: null,
    specTitle: "refactor auth",
    costTotalUsd: "3.20",
    lastEventAt: "2026-05-27T09:40:00.000Z",
    needsReview: false,
  },
];

// Per-run cost records spanning all THREE pricing models + all real cost bases.
const COSTS: Record<string, unknown[]> = {
  run_a1: [
    {
      id: 1,
      runId: "run_a1",
      taskId: "t1",
      projectId: "project_easy",
      cli: "claude",
      provider: "anthropic",
      model: "opus-4.7",
      inputTokens: 200000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 80000,
      reasoningOutputTokens: 0,
      totalTokens: 280000,
      costUsd: "10.00",
      billingMode: "per_token",
      costBasis: "provider_response",
      recordedAt: "2026-05-28T10:05:00.000Z",
    },
    {
      id: 2,
      runId: "run_a1",
      taskId: "t2",
      projectId: "project_easy",
      cli: "codex",
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 300000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 120000,
      reasoningOutputTokens: 0,
      totalTokens: 420000,
      costUsd: null,
      billingMode: "subscription",
      costBasis: "unknown",
      recordedAt: "2026-05-28T10:10:00.000Z",
    },
  ],
  run_b2: [
    {
      id: 3,
      runId: "run_b2",
      taskId: "t3",
      projectId: "project_easy",
      cli: "opencode",
      provider: "qwen",
      model: "qwen-coder",
      inputTokens: 150000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 60000,
      reasoningOutputTokens: 0,
      totalTokens: 210000,
      costUsd: null,
      billingMode: "self_hosted",
      costBasis: "unknown",
      recordedAt: "2026-05-27T09:10:00.000Z",
    },
    {
      id: 4,
      runId: "run_b2",
      taskId: "t4",
      projectId: "project_easy",
      cli: "claude",
      provider: "anthropic",
      model: "sonnet-4.6",
      inputTokens: 40000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 20000,
      reasoningOutputTokens: 0,
      totalTokens: 60000,
      costUsd: "3.00",
      billingMode: "per_token",
      costBasis: "ccusage",
      recordedAt: "2026-05-27T09:20:00.000Z",
    },
  ],
};

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
    // run costs: .../runs/:runId/costs (check before the run-list match)
    const costsMatch = /\/runs\/([^/?]+)\/costs/u.exec(url);
    if (costsMatch !== null) {
      const items = COSTS[costsMatch[1] ?? ""] ?? [];
      return new Response(JSON.stringify({ items, nextCursor: null }), { status: 200 });
    }
    // run list: .../runs  (optionally with ?status=)
    if (/\/runs(\?|$)/u.test(url)) {
      const status = new URL(url, "http://x").searchParams.get("status");
      const items = status === null || status === "" ? RUNS : RUNS.filter((r) => r.status === status);
      return new Response(JSON.stringify({ items }), { status: 200 });
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
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

// The forbidden fabricated-source placeholder (built at runtime so the literal
// never appears in source — the architecture check bans it project-wide).
const FORBIDDEN_PLACEHOLDER = ["legacy", "unknown"].join("_");

describe("costs dashboard (/costs)", () => {
  it("overrides the P2B-0001 placeholder with the real cost screen", async () => {
    const app = await build();
    const html = await (await app.request("/costs")).text();
    expect(html).toContain("where the money goes");
    expect(html).not.toContain("documented placeholder");
  });

  it("renders all three pricing-model source cards", async () => {
    const app = await build();
    const html = await (await app.request("/costs")).text();
    expect(html).toContain("per-token · llm api");
    expect(html).toContain("subscription window");
    expect(html).toContain("self-hosted · opportunity");
    // The §4 model tags.
    expect(html).toContain("model 1 · real dollars");
    expect(html).toContain("model 2 · use-it-or-lose-it");
    expect(html).toContain("model 3 · window-equiv");
  });

  it("shows every provider row's REAL cost source, no fabricated placeholder", async () => {
    const app = await build();
    // ?range=all so the assertion covers every fixture row regardless of how
    // long ago the fixture's recordedAt is vs the wall clock. The default 30d
    // pill is a UI affordance, not a test concern — this test's intent is
    // "every provider row shows its real source", not "the 30d pill works".
    const html = await (await app.request("/costs?range=all")).text();
    expect(html).toContain("provider response · real charge");
    expect(html).toContain("ccusage · real billed");
    // Unknown basis is honestly labelled + shows no invented dollar.
    expect(html).toContain("no priced basis · tokens only");
    expect(html).toContain("no $ basis");
    // The forbidden placeholder string must never appear.
    expect(html).not.toContain(FORBIDDEN_PLACEHOLDER);
  });

  it("renders burn projection, headroom, and observed panels with numbers", async () => {
    const app = await build();
    // ?range=all so the led $13.00 headline (sum of both runs' real spend)
    // is wall-clock-independent. See the sibling test for the rationale.
    const html = await (await app.request("/costs?range=all")).text();
    expect(html).toContain("burn + forecast");
    // The forecast surfaces a run-rate month-end ESTIMATE over BOTH figures.
    expect(html).toContain("est. month-end · real");
    expect(html).toContain("est. month-end · equivalent");
    // Both the real-spend and the api-equivalent trend are surfaced side-by-side.
    expect(html).toContain("daily real");
    expect(html).toContain("daily equiv");
    expect(html).toContain("headroom · subscription + self-hosted");
    expect(html).toContain("observed · reported, not targeted");
    expect(html).toContain("specs merged");
    // Total REAL spend = 10 + 3 = $13.00 across both runs (the led headline figure).
    expect(html).toContain("$13.00");
  });

  it("renders the date-range filter pills + export-csv action", async () => {
    const app = await build();
    const html = await (await app.request("/costs")).text();
    expect(html).toContain(">7d<");
    expect(html).toContain(">30d<");
    expect(html).toContain(">90d<");
    expect(html).toContain("export csv");
    expect(html).toContain('href="/costs/export.csv"');
  });

  // the subscription-window utilization heatmap on the costs page.
  it("renders the subscription-window heatmap + overnight-audits Forge prompt", async () => {
    const app = await build();
    const html = await (await app.request("/costs")).text();
    // Panel heading + the 5-window y-axis labels.
    expect(html).toContain("subscription window");
    expect(html).toContain("utilization");
    expect(html).toContain("00 – 05");
    expect(html).toContain("20 – 00");
    // The grid is server-rendered (cells carry the design-token ember fill).
    expect(html).toContain("heatmap-row");
    expect(html).toContain("heatmap-cell");
    expect(html).toContain("avg fill");
    // The "scheduled overnight audits" Forge affordance opens the palette,
    // pre-seeded with the audit prompt (stays inside the surface).
    expect(html).toContain("ask forge to schedule overnight audits");
    expect(html).toContain('data-island-trigger="palette"');
    expect(html).toContain("data-palette-prefill");
  });
});

describe("costs CSV export (/costs/export.csv)", () => {
  it("emits a CSV with the real cost_basis per row", async () => {
    const app = await build();
    const res = await app.request("/costs/export.csv");
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body.split("\n")[0]).toBe("cli,model,provider,billing_mode,cost_basis,runs,total_tokens,cost_usd,share");
    expect(body).toContain("provider_response");
    expect(body).toContain("ccusage");
    expect(body).toContain("unknown");
    expect(body).not.toContain(FORBIDDEN_PLACEHOLDER);
  });
});

describe("history list (/history)", () => {
  it("lists prior runs from the P2A-0014 run-list read API", async () => {
    const app = await build();
    const html = await (await app.request("/history")).text();
    expect(html).toContain("prior runs");
    expect(html).toContain("add health endpoint");
    expect(html).toContain("refactor auth");
    // Cost totals from the run list.
    expect(html).toContain("$12.34");
    expect(html).toContain("$3.20");
    // Outcome badges.
    expect(html).toContain("merged-ready");
    expect(html).toContain("halted");
    // Row links to the run detail.
    expect(html).toContain("/projects/project_easy/runs/run_a1");
  });

  it("applies the status filter through the run-list API", async () => {
    const app = await build();
    const html = await (await app.request("/history?status=failed")).text();
    expect(html).toContain("refactor auth");
    expect(html).not.toContain("add health endpoint");
  });
});
