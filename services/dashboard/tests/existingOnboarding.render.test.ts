// rendered-HTML assertions for the brownfield onboarding FULL track:
// the 5-step shell (link → recon → config-injection PR → DAG seed →
// governance), each driven by a MOCKED orchestrator route via global fetch.
// Mirrors the greenfield.render pattern: stub the pg pool + mock the
// orchestrator APIs, then assert the HTML.

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
const PROJECT = {
  projectId: "project_linked",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

const RECON_RESULT = {
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  filesIndexed: 84,
  report: {
    identity: {
      slug: "tanren-fixture-easy",
      purpose: "smoke fixture for the tanren loop",
      inferredFrom: "README.md",
    },
    personas: [
      {
        name: "developer · maintainer",
        description: "maintains the codebase",
        inferredFrom: "code",
      },
    ],
    behaviors: [{ persona: "developer · maintainer", title: "build & test the project", inferredFrom: "ci" }],
    architecture: [{ layer: "ci", detail: "github actions" }],
    risks: [{ severity: "warn", note: "no CODEOWNERS file" }],
    gaps: [
      {
        id: "design-dna",
        chapter: "design dna",
        question: "default to industrial?",
        options: ["use industrial"],
      },
    ],
  },
};

const CONFIG_INJECTION_RESULT = {
  pullRequest: {
    number: 48,
    url: "https://github.com/cat-cave/tanren-fixture-easy/pull/48",
    branch: "tanren/integrate",
    filesCommitted: [".tanren/PROJECT.md", ".tanren/ci.yml"],
  },
  files: [
    { path: ".tanren/PROJECT.md", addedLines: 30 },
    { path: ".tanren/ci.yml", addedLines: 14 },
  ],
  noRunsUntilMerged: true,
};

const SEED_RESULT = {
  seeded: [
    {
      specId: "spec_1",
      title: "writer hangs on long writes",
      source: "github_issue",
      origin: "gh#142",
    },
    {
      specId: "spec_2",
      title: "default to industrial?",
      source: "agent_gap",
      origin: "design-dna",
    },
  ],
  duplicatesDropped: 1,
  fromIssues: 1,
  fromGaps: 1,
};

const GOVERNANCE_RESULT = {
  projectId: "project_linked",
  governancePosture: "audit_only",
  externalPushPolicy: "external pushes observed · tanren opens no PRs",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url) && method === "GET")
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url) && method === "POST")
      return new Response(JSON.stringify(PROJECT), { status: 201 });
    if (url.endsWith("/link") && method === "POST")
      return new Response(
        JSON.stringify({
          projectId: PROJECT.projectId,
          repoUrl: PROJECT.repoUrl,
          orgId: ORG.id,
          detectedFiles: [],
          writesPerformed: 0,
        }),
        { status: 200 },
      );
    if (url.endsWith("/recon") && method === "POST") return new Response(JSON.stringify(RECON_RESULT), { status: 200 });
    if (url.endsWith("/config-injection") && method === "POST")
      return new Response(JSON.stringify(CONFIG_INJECTION_RESULT), { status: 201 });
    if (url.endsWith("/seed-dag") && method === "POST")
      return new Response(JSON.stringify(SEED_RESULT), { status: 201 });
    if (url.endsWith("/governance") && method === "POST")
      return new Response(JSON.stringify(GOVERNANCE_RESULT), { status: 200 });
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
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

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const REPORT_JSON = JSON.stringify(RECON_RESULT.report);

describe("brownfield · 5-step shell (step 1 link)", () => {
  it("renders the full-track journey strip + the link form", async () => {
    const app = await build();
    const html = await (await app.request("/onboarding/existing")).text();
    expect(html).toContain('data-screen="onboarding-existing-full"');
    expect(html).toContain("existing project · brownfield");
    expect(html).toContain("link an");
    expect(html).toContain("decide");
  });
});

describe("brownfield · recon (step 2)", () => {
  it("link POST runs recon + renders the pre-filled chapters + gaps", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing/link", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ repoUrl: PROJECT.repoUrl, name: "tanren-fixture-easy" }),
    });
    const html = await res.text();
    expect(html).toContain("knows most of it");
    expect(html).toContain("indexed 84 files");
    expect(html).toContain("developer · maintainer");
    expect(html).toContain("no CODEOWNERS file");
    // the gap card.
    expect(html).toContain("default to industrial?");
  });
});

describe("brownfield · config-injection PR (step 3)", () => {
  it("renders the 6-file preview with per-file exclude checkboxes", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        phase: "advance",
        step: "2",
        repoUrl: PROJECT.repoUrl,
        projectId: PROJECT.projectId,
        report: REPORT_JSON,
      }),
    });
    const html = await res.text();
    // "review what we'll add" (apostrophe HTML-escaped)
    expect(html).toContain("add");
    expect(html).toContain(".tanren/PROJECT.md");
    expect(html).toContain(".tanren/ci.yml");
    expect(html).toContain('name="keep"');
    expect(html).toContain("open the pr ↗");
  });

  it("open-pr POST opens the PR + shows the no-runs-until-merged confirmation", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams([
        ["phase", "open-pr"],
        ["step", "3"],
        ["repoUrl", PROJECT.repoUrl],
        ["projectId", PROJECT.projectId],
        ["report", REPORT_JSON],
        ["posture", "strict"],
        ["keep", ".tanren/PROJECT.md"],
        ["keep", ".tanren/ci.yml"],
      ]),
    });
    const html = await res.text();
    expect(html).toContain("pr");
    expect(html).toContain("#48");
    expect(html).toContain("no runs until merged");
    expect(html).toContain("pull/48");
  });
});

describe("brownfield · DAG seed (step 4)", () => {
  it("seed POST creates specs from issues + gaps and renders the source legend", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        phase: "seed",
        step: "4",
        repoUrl: PROJECT.repoUrl,
        projectId: PROJECT.projectId,
        report: REPORT_JSON,
      }),
    });
    const html = await res.text();
    expect(html).toContain("from github issue");
    expect(html).toContain("from agent gap");
    expect(html).toContain("writer hangs on long writes");
    expect(html).toContain("1 from issues");
  });

  it("renders seed-DAG failure as unavailable, not as an idle empty state", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
          status: 200,
        });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      if (/\/orgs\/[^/]+\/projects$/u.test(url) && method === "GET")
        return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
      if (url.endsWith("/seed-dag") && method === "POST")
        return new Response(JSON.stringify({ error: "seed_dag_unavailable" }), { status: 503 });
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        phase: "seed",
        step: "4",
        repoUrl: PROJECT.repoUrl,
        projectId: PROJECT.projectId,
        report: REPORT_JSON,
      }),
    });
    const html = await res.text();
    expect(html).toContain("could not seed the spec dag — try again");
    expect(html).not.toContain("seed_dag_unavailable");
    expect(html).toContain("seed the dag ↗");
    expect(html).not.toContain("Seeded <b>");
  });
});

describe("brownfield · governance (step 5)", () => {
  it("governance POST persists the posture + renders the external-push policy", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        phase: "governance",
        step: "5",
        repoUrl: PROJECT.repoUrl,
        projectId: PROJECT.projectId,
        posture: "audit_only",
      }),
    });
    const html = await res.text();
    expect(html).toContain("Posture saved");
    expect(html).toContain("audit_only");
    expect(html).toContain("tanren opens no PRs");
    expect(html).toContain("/projects/project_linked");
  });

  it("renders all 3 posture options on the picker", async () => {
    const app = await build();
    const res = await app.request("/onboarding/existing", {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        phase: "advance",
        step: "4",
        repoUrl: PROJECT.repoUrl,
        projectId: PROJECT.projectId,
        report: REPORT_JSON,
      }),
    });
    const html = await res.text();
    expect(html).toContain("you describe, we forge");
    expect(html).toContain("humans + tanren both push");
    expect(html).toContain("tanren just watches");
  });
});
