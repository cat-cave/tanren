// PR #943 final dependency-plane audit: the spec-detail view composes TWO
// independent `listRunsMaybe` planes — spec-local runs (history/economics) and
// project-wide runs (dependency-chip truth). These render proofs pin that a
// failure on one plane NEVER discards a successful list on the other, so a
// completed dependency can never be re-rendered as a fake "queued" and a failed
// plane can never be laundered into an all-clear. Drives the REAL route
// (`loadSpecDetail`) end-to-end via stubbed fetch; the two planes are told apart
// by the `?specId=` query (spec-local) vs the bare project-wide runs path.

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

const SPEC_SELF = {
  specId: "spec_1",
  projectId: "project_1",
  title: "Spec One",
  description: "d",
  acceptanceCriteria: ["a"],
  dependsOn: ["dep_1"],
  status: "ready",
  priority: "P1",
};
const SPEC_DEP = {
  specId: "dep_1",
  projectId: "project_1",
  title: "Dep",
  description: "",
  acceptanceCriteria: [],
  dependsOn: [],
  status: "ready",
  priority: "P1",
};

interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  branch: string;
  trigger: string;
  status: string;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  prUrl: string | null;
  specTitle: string;
  costTotalUsd: string | null;
  lastEventAt: string | null;
  needsReview: boolean;
}

function runRow(over: Partial<RunRow>): RunRow {
  return {
    runId: "r_dep_1",
    specId: "dep_1",
    projectId: "project_1",
    branch: "main",
    trigger: "manual",
    status: "completed",
    outcome: "ok",
    startedAt: "2026-05-01T00:00:00.000Z",
    endedAt: "2026-05-01T01:00:00.000Z",
    prUrl: null,
    specTitle: "Dep",
    costTotalUsd: "1.50",
    lastEventAt: "2026-05-01T01:00:00.000Z",
    needsReview: false,
    ...over,
  };
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

const DOWN = () => new Response("down", { status: 503 });
const okRuns = (rows: RunRow[]) => new Response(JSON.stringify({ items: rows }), { status: 200 });

/**
 * Branch the two run-list planes by URL: spec-local carries `?specId=`, the
 * project-wide call is the bare `/runs` path. Everything else is the shared
 * shell/spec matrix.
 */
function stubFetchPlanes(specLocal: Response, projectWide: Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method !== "GET") return new Response("{}", { status: 200 });
    if (/\/runs\?specId=/u.test(url)) return specLocal;
    if (/\/runs(?:\?|$)/u.test(url)) return projectWide;
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (/\/projects\/[^/]+\/specs$/u.test(url))
      return new Response(JSON.stringify({ specs: [SPEC_SELF, SPEC_DEP] }), { status: 200 });
    if (/\/projects\/[^/]+\/insights/u.test(url))
      return new Response(JSON.stringify({ insights: [] }), { status: 200 });
    if (/\/projects\/[^/]+\/milestones/u.test(url))
      return new Response(JSON.stringify({ milestones: [] }), { status: 200 });
    if (/\/projects\/[^/]+\/feed/u.test(url)) return new Response(JSON.stringify({ items: [] }), { status: 200 });
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

const SPEC_PAGE = "/projects/project_1/specs/spec_1";

describe("spec-detail dependency-plane independence (listRunsMaybe)", () => {
  it("project-wide 200 (completed dep) + spec-local 503 → dep chip stays done, spec-local history unavailable", async () => {
    // The headline former bug: spec-local failure used to discard the successful
    // project-wide list and re-render a completed dep as a fake "queued".
    stubFetchPlanes(DOWN(), okRuns([runRow({ specId: "dep_1", status: "completed", outcome: "ok" })]));
    const html = await (await (await build()).request(SPEC_PAGE)).text();
    // Dependency chip truth comes from the project-wide plane (still up) — the
    // dep_1 chip stays done and is NEVER downgraded to a fake "queued".
    expect(html).toContain('class="dep-chip s-done" data-spec-id="dep_1"');
    expect(html).not.toContain('s-queued" data-spec-id="dep_1"');
    // Spec-local history + economics are loudly unavailable — never an empty
    // all-clear fabricated from the failed plane.
    expect(html).toContain("data-runs-unavailable");
    expect(html).toContain("data-economics-unavailable");
  });

  it("project-wide 503 + spec-local 200 → dependency chip unavailable, spec-local history usable", async () => {
    stubFetchPlanes(
      okRuns([
        runRow({ runId: "r_self", specId: "spec_1", status: "completed", outcome: "ok", specTitle: "Spec One" }),
      ]),
      DOWN(),
    );
    const html = await (await (await build()).request(SPEC_PAGE)).text();
    // Dep chip degrades to its explicit unavailable state — never a fake status
    // invented from the empty project-wide map.
    expect(html).toContain('class="dep-chip s-unavailable" data-spec-id="dep_1"');
    // Spec-local run history is still usable: the run is listed, not unavailable.
    expect(html).not.toContain("data-runs-unavailable");
    expect(html).toContain("r_self");
  });

  it("both 200 empty → genuine queued/empty semantics unchanged", async () => {
    stubFetchPlanes(okRuns([]), okRuns([]));
    const html = await (await (await build()).request(SPEC_PAGE)).text();
    // A dep with no runs is truthfully "queued"; both planes report available.
    expect(html).toContain('class="dep-chip s-queued" data-spec-id="dep_1"');
    expect(html).not.toContain("data-runs-unavailable");
    expect(html).not.toContain('s-unavailable" data-spec-id="dep_1"');
    expect(html).toContain("No runs yet");
  });

  it("both fail → both loud, no all-clear / no-run / action derived from emptiness", async () => {
    stubFetchPlanes(DOWN(), DOWN());
    const html = await (await (await build()).request(SPEC_PAGE)).text();
    expect(html).toContain('class="dep-chip s-unavailable" data-spec-id="dep_1"');
    expect(html).toContain("data-runs-unavailable");
    expect(html).toContain("data-economics-unavailable");
    // No forge affordance is invented from a failed empty run-list.
    expect(html).not.toContain("forge it now");
    expect(html).not.toContain("No runs yet");
  });
});
