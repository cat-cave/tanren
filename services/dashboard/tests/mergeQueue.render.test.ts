// Merge-queue panel rendered-HTML tests. Mirrors the DORA harness: build the app
// with a stubbed pool + a mocked orchestrator (global fetch), then assert the
// rendered /merge-queue screen.
//
// Coverage:
//   - /merge-queue mounts the real screen (not the placeholder);
//   - rebase-vs-rebuild economics render with formatted token figures + verdict;
//   - the native-queue stats (depth, time-in-queue, batch pass-rate, dequeues) render;
//   - the window pills render and a non-default window is forwarded;
//   - a null/uncomputable figure renders "—", never a fabricated zero.

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

function bucket(count: number, medianTokens: number | null): unknown {
  return { count, medianTokens, tokensSample: count, medianWallClockSeconds: null, wallClockSample: 0 };
}

// A full payload: rebase kept work alive cheaper (8.0k) than replanned rebuild (24k).
const METRICS_FULL = {
  projectId: "project_easy",
  windowStart: "2026-04-28T00:00:00.000Z",
  windowEnd: "2026-05-28T00:00:00.000Z",
  windowDays: 30,
  buckets: {
    rebased_clean: bucket(12, 8000),
    rebased_resolved: bucket(5, 9000),
    replanned: bucket(2, 24000),
    writer_rework: bucket(0, null),
    parked: bucket(0, null),
    held: bucket(1, null),
  },
  rebaseVsRebuild: {
    keptAliveMedianTokens: 8000,
    keptAliveSample: 17,
    replannedMedianTokens: 24000,
    replannedSample: 2,
    rebaseCheaper: true,
  },
  proofReuseCount: 9,
  totalRebases: 20,
  computedAt: "2026-05-28T00:00:00.000Z",
};

const STATS_FULL = {
  projectId: "project_easy",
  windowStart: "2026-04-28T00:00:00.000Z",
  windowEnd: "2026-05-28T00:00:00.000Z",
  windowDays: 30,
  depthSeries: [
    { at: "2026-05-01T00:00:00.000Z", depth: 3 },
    { at: "2026-05-02T00:00:00.000Z", depth: 6 },
  ],
  maxDepth: 6,
  meanDepth: 2.3,
  medianTimeInQueueSeconds: 900,
  maxTimeInQueueSeconds: 3600,
  timeInQueueSample: 20,
  batchesChecked: 10,
  batchesPassed: 8,
  batchPassRate: 0.8,
  batchesBisected: 2,
  culpritsIsolated: 2,
  bisectChecksPerformed: 5,
  dequeues: { conflict: 1, blocked: 0, failed: 1, superseded: 0 },
  maxStackDepth: 4,
  computedAt: "2026-05-28T00:00:00.000Z",
};

// A sparse window: nothing has rebased / queued yet → null medians, no comparison.
const METRICS_EMPTY = {
  ...METRICS_FULL,
  buckets: {
    rebased_clean: bucket(0, null),
    rebased_resolved: bucket(0, null),
    replanned: bucket(0, null),
    writer_rework: bucket(0, null),
    parked: bucket(0, null),
    held: bucket(0, null),
  },
  rebaseVsRebuild: {
    keptAliveMedianTokens: null,
    keptAliveSample: 0,
    replannedMedianTokens: null,
    replannedSample: 0,
    rebaseCheaper: null,
  },
  proofReuseCount: 0,
  totalRebases: 0,
};
const STATS_EMPTY = {
  ...STATS_FULL,
  depthSeries: [],
  maxDepth: null,
  meanDepth: null,
  medianTimeInQueueSeconds: null,
  maxTimeInQueueSeconds: null,
  timeInQueueSample: 0,
  batchesChecked: 0,
  batchesPassed: 0,
  batchPassRate: null,
  batchesBisected: 0,
  culpritsIsolated: 0,
  bisectChecksPerformed: 0,
  dequeues: { conflict: 0, blocked: 0, failed: 0, superseded: 0 },
  maxStackDepth: null,
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let metricsPayload: unknown = METRICS_FULL;
let statsPayload: unknown = STATS_FULL;
// When true, the two metrics endpoints return 500 so the client yields undefined.
let failReads = false;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    // The two metrics endpoints MUST be matched before the generic /projects
    // fallback (their paths also contain "/projects").
    if (/\/integration-metrics(\?|$)/u.test(url)) {
      return failReads
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ metrics: metricsPayload }), { status: 200 });
    }
    if (/\/queue-stats(\?|$)/u.test(url)) {
      return failReads
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ stats: statsPayload }), { status: 200 });
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  metricsPayload = METRICS_FULL;
  statsPayload = STATS_FULL;
  failReads = false;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("merge-queue panel (/merge-queue)", () => {
  it("mounts the real screen, not a placeholder", async () => {
    const app = await build();
    const html = await (await app.request("/merge-queue")).text();
    expect(html).toContain("how work merges");
    expect(html).not.toContain("documented placeholder");
  });

  it("renders rebase-vs-rebuild economics with the cheaper verdict", async () => {
    const app = await build();
    const html = await (await app.request("/merge-queue")).text();
    expect(html).toContain("kept-alive cost");
    expect(html).toContain("rebuild cost");
    // 8000 tokens → "8.0k"; 24000 → "24k".
    expect(html).toContain("8.0k");
    expect(html).toContain("24k");
    expect(html).toContain("rebase &lt; rebuild");
    expect(html).toContain("clean rebases");
  });

  it("renders native-queue stats and the dequeue breakdown", async () => {
    const app = await build();
    const html = await (await app.request("/merge-queue")).text();
    expect(html).toContain("max depth");
    expect(html).toContain("batch pass rate");
    // Formatted figures: 8/10 batches → 80%, 900s median time-in-queue → 15m, mean depth 2.3.
    expect(html).toContain("80%");
    expect(html).toContain("15m");
    expect(html).toContain("2.3");
    expect(html).toContain("dequeues");
  });

  it("renders the window pills and forwards a non-default window", async () => {
    const app = await build();
    const html = await (await app.request("/merge-queue?windowDays=7")).text();
    expect(html).toContain(">7d<");
    expect(html).toContain(">30d<");
    expect(html).toContain(">90d<");
    expect(html).toContain("7d window");
  });

  it("renders an em-dash for uncomputable figures and no comparison when sparse", async () => {
    metricsPayload = METRICS_EMPTY;
    statsPayload = STATS_EMPTY;
    const app = await build();
    const html = await (await app.request("/merge-queue")).text();
    expect(html).toContain("—");
    expect(html).toContain("not enough samples");
  });

  it("renders 'unavailable', not fabricated zeros, when the orchestrator read fails", async () => {
    failReads = true;
    const app = await build();
    const html = await (await app.request("/merge-queue")).text();
    expect(html).toContain("Rebase metrics unavailable");
    expect(html).toContain("Queue statistics unavailable");
    // A failed read must NOT render the zero-filled stat rows.
    expect(html).not.toContain("speculative batches passed");
    expect(html).not.toContain("dequeues (left without merging)");
  });
});
