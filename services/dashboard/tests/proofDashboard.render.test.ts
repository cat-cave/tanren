// rv-23 — render proof for the runtime-verification proof dashboard surfaces. The
// orchestrator is stubbed so we can drive the FAIL-CLOSED states deterministically:
// a surface whose endpoint returns 503 (or malformed JSON) must render a BLOCKED
// state, never a fabricated green; a missing production verdict must render
// `unproven`, never passed.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountProofDashboardScreens } from "../src/routes/proofDashboard/index.js";

const ORG = { id: "org_acme", kind: "github_org", login: "cat-cave", displayName: "Cat Cave", role: "org:admin" };
const PROJECTS = [
  {
    projectId: "project_easy",
    name: "fixture-easy",
    repoUrl: "https://github.com/cat-cave/fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;

let matrixUnavailable = false;

function matrixBody(): unknown {
  return {
    version: "v1",
    orgId: "org_acme",
    projectId: "project_easy",
    rows: [
      {
        behaviorRevisionId: "br_login",
        behaviorId: "behavior_login",
        title: "operator can sign in",
        revisionNumber: 1,
        status: "active",
        designContractDigest: D,
        owningSpecIds: ["spec_login"],
        latestPreview: {
          outcome: "passed",
          requiredAssertionCount: 3,
          executedAssertionCount: 3,
          flakeState: "stable",
          artifactDigest: CAS,
          runId: "run_preview",
          createdAt: "2026-07-19T00:00:00.000Z",
        },
        latestProduction: null,
        lastProvenArtifactDigest: null,
        quarantined: true,
        verdictCount: 1,
      },
    ],
  };
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf", expiresAt: "2030-01-01" }));
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }));
    if (url.endsWith("/orgs/org_acme/projects")) return new Response(JSON.stringify({ projects: PROJECTS }));
    if (url.endsWith("/behavior-proof-matrix")) {
      return matrixUnavailable
        ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
        : new Response(JSON.stringify(matrixBody()));
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  matrixUnavailable = false;
  mockOrchestrator();
});
afterEach(() => vi.unstubAllGlobals());

function build(): Hono {
  const app = new Hono();
  mountProofDashboardScreens(app, { orchestratorUrl: "http://orchestrator" });
  return app;
}

describe("rv-23 visible behavior proof dashboard", () => {
  it("renders the matrix with a passed preview but an UNPROVEN production plane (never laundered green)", async () => {
    const html = await (await build().request("/projects/project_easy/behavior-proof")).text();
    expect(html).toContain("Behavior Proof Matrix");
    expect(html).toContain("operator can sign in");
    // preview passed, production unproven — the distinct-plane guarantee.
    expect(html).toContain("passed");
    expect(html).toContain("unproven");
    // "none proven" == no last-proven artifact digest.
    expect(html).toContain("none proven");
    expect(html).toContain("quarantined");
  });

  it("FAIL-CLOSED: an unavailable matrix endpoint renders a BLOCKED state, not a green one", async () => {
    matrixUnavailable = true;
    const html = await (await build().request("/projects/project_easy/behavior-proof")).text();
    expect(html).toContain("behavior proof matrix unavailable");
    expect(html).toContain("BLOCKED");
    expect(html).not.toContain("proven in production");
  });

  it("FAIL-CLOSED: quarantine surface with an unresolved endpoint renders BLOCKED", async () => {
    // no /flake-quarantines stub → 404 → undefined → blocked.
    const html = await (await build().request("/projects/project_easy/behavior-proof/quarantines")).text();
    expect(html).toContain("flake quarantine state unavailable");
    expect(html).toContain("BLOCKED");
  });
});
