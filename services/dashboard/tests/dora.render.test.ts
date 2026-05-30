// P3-0019 DORA metrics panel rendered-HTML tests. Mirrors the P2B-0005 costs
// harness: build the app with a stubbed pool + a mocked orchestrator (global
// fetch), then assert the rendered /dora screen.
//
// Coverage:
//   - /dora overrides the P2B-0001 placeholder (real screen);
//   - all four DORA metrics render with formatted values + samples;
//   - the panel is explicitly labelled "reported, not targeted";
//   - the window pills render and a non-default window is forwarded;
//   - a null/uncomputable metric renders "—", never a fabricated zero.

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

// A full payload: lead 21h, deploy 2.1/d, CFR 4.8%, MTTR present.
const DORA_FULL = {
  projectId: "project_easy",
  windowStart: "2026-04-28T00:00:00.000Z",
  windowEnd: "2026-05-28T00:00:00.000Z",
  windowDays: 30,
  leadTimeSeconds: { value: 21 * 3600, sample: 42 },
  deployFrequencyPerDay: { value: 2.1, sample: 63 },
  changeFailureRate: { value: 0.048, sample: 84 },
  meanTimeToRestoreSeconds: { value: 90 * 60, sample: 4 },
  totals: { merges: 63, finishedRuns: 84, failedRuns: 4, recoveries: 4 },
  computedAt: "2026-05-28T00:00:00.000Z",
};

// A sparse payload: nothing has merged / halted yet → null metrics.
const DORA_EMPTY = {
  ...DORA_FULL,
  leadTimeSeconds: { value: null, sample: 0 },
  deployFrequencyPerDay: { value: null, sample: 0 },
  changeFailureRate: { value: null, sample: 0 },
  meanTimeToRestoreSeconds: { value: null, sample: 0 },
  totals: { merges: 0, finishedRuns: 0, failedRuns: 0, recoveries: 0 },
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let doraPayload: unknown = DORA_FULL;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (/\/dora(\?|$)/u.test(url)) {
      return new Response(JSON.stringify({ metrics: doraPayload }), { status: 200 });
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  doraPayload = DORA_FULL;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("DORA metrics panel (/dora)", () => {
  it("overrides the P2B-0001 placeholder with the real metrics screen", async () => {
    const app = await build();
    const html = await (await app.request("/dora")).text();
    expect(html).toContain("how delivery is flowing");
    expect(html).not.toContain("documented placeholder");
  });

  it("renders all four DORA metrics with formatted values", async () => {
    const app = await build();
    const html = await (await app.request("/dora")).text();
    expect(html).toContain("lead time");
    expect(html).toContain("deploy frequency");
    expect(html).toContain("change-failure rate");
    expect(html).toContain("time to restore");
    // Formatted figures: 21h lead, 2.1/d deploys, 4.8% CFR, 1.5h MTTR (90m).
    expect(html).toContain("21h");
    expect(html).toContain("2.1/d");
    expect(html).toContain("4.8%");
    expect(html).toContain("1.5h");
    // Sample sizes surfaced.
    expect(html).toContain("n=42");
  });

  it("is explicitly labelled reported, not targeted", async () => {
    const app = await build();
    const html = await (await app.request("/dora")).text();
    expect(html).toContain("reported, not targeted");
    expect(html).toContain("dora-like");
  });

  it("renders the window pills and forwards a non-default window", async () => {
    const app = await build();
    const html = await (await app.request("/dora?windowDays=7")).text();
    expect(html).toContain(">7d<");
    expect(html).toContain(">30d<");
    expect(html).toContain(">90d<");
    expect(html).toContain("7d window");
  });

  it("renders an em-dash for uncomputable metrics, never a fabricated zero", async () => {
    doraPayload = DORA_EMPTY;
    const app = await build();
    const html = await (await app.request("/dora")).text();
    // The no-data sentinel is present; the panel does not invent a 0 value.
    expect(html).toContain("—");
    expect(html).toContain("n=0");
  });
});
