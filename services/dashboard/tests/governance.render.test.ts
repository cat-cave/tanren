// GV-1 governance settings proofs: the real screen reads the canonical
// org/project governance API, writes only auditPosture through its admin PUT,
// keeps failed writes visible, and fails loudly on malformed success payloads.

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

const CURRENT_GOVERNANCE = {
  reviewPolicy: "simulated",
  mergeIntegration: "native_queue",
  governancePosture: "strict",
  auditPosture: {
    blockReviewAt: "P1",
    p2p3Handling: "fix-if-idle",
    autonomousRemediation: false,
  },
  insightThresholds: {},
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let governancePayload: unknown;
let governanceGetStatus: number;
let governancePutStatus: number;
let governancePutError: string;
let malformedPutSuccess: boolean;
let putBodies: unknown[];
let lastPutHeaders: Record<string, string> | undefined;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf-live", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });

    if (/\/orgs\/[^/]+\/projects\/[^/]+\/governance$/u.test(url)) {
      if (method === "PUT") {
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        putBodies.push(body);
        lastPutHeaders = (init?.headers ?? {}) as Record<string, string>;
        if (governancePutStatus >= 200 && governancePutStatus < 300) {
          const auditPosture = (body as { auditPosture?: unknown } | undefined)?.auditPosture;
          governancePayload = { ...(governancePayload as object), auditPosture };
          const responseBody = malformedPutSuccess
            ? { ...(governancePayload as object), auditPosture: { blockReviewAt: "P3" } }
            : governancePayload;
          return new Response(JSON.stringify(responseBody), { status: governancePutStatus });
        }
        return new Response(JSON.stringify({ error: governancePutError }), { status: governancePutStatus });
      }
      if (governanceGetStatus >= 200 && governanceGetStatus < 300) {
        return new Response(JSON.stringify(governancePayload), { status: governanceGetStatus });
      }
      return new Response(JSON.stringify({ error: "governance_unavailable" }), { status: governanceGetStatus });
    }

    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  governancePayload = structuredClone(CURRENT_GOVERNANCE);
  governanceGetStatus = 200;
  governancePutStatus = 200;
  governancePutError = "governance_write_failed";
  malformedPutSuccess = false;
  putBodies = [];
  lastPutHeaders = undefined;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

async function postForm(app: Awaited<ReturnType<typeof build>>, body: string): Promise<Response> {
  return app.request("/settings/governance", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

describe("audit-posture governance screen (/settings/governance)", () => {
  it("mounts exactly once in navigation and renders the canonical current posture", async () => {
    const app = await build();
    const html = await (await app.request("/settings/governance?projectId=project_easy")).text();

    expect(html).toContain("audit posture");
    expect(html).toContain("data-governance-panel");
    expect(html).toContain('data-current-block-review-at="P1"');
    expect(html).toContain('data-current-p2p3-handling="fix-if-idle"');
    expect(html).toContain('data-current-autonomous-remediation="false"');
    expect(html).toContain("reviewPolicy=simulated");
    expect(html).not.toContain("documented placeholder");
    expect(html.match(/href="\/settings\/governance"/gu)).toHaveLength(1);
    expect(app.routes.filter((route) => route.method === "GET" && route.path === "/settings/governance")).toHaveLength(
      1,
    );
  });

  it("admin save sends only auditPosture to the canonical PUT with outbound CSRF", async () => {
    const app = await build();
    const response = await postForm(
      app,
      "projectId=project_easy&blockReviewAt=P3&p2p3Handling=route-to-dag&autonomousRemediation=true",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("ok=saved");
    expect(putBodies).toEqual([
      {
        auditPosture: {
          blockReviewAt: "P3",
          p2p3Handling: "route-to-dag",
          autonomousRemediation: true,
        },
      },
    ]);
    expect(lastPutHeaders?.["x-csrf-token"]).toBe("csrf-live");

    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("Audit posture saved through the canonical governance authority.");
    expect(html).toContain('data-current-block-review-at="P3"');
    expect(html).toContain('data-current-autonomous-remediation="true"');
  });

  it("rejects invalid form values before any orchestrator write and leaves the error visible", async () => {
    const app = await build();
    const response = await postForm(
      app,
      "projectId=project_easy&blockReviewAt=P9&p2p3Handling=fix-if-idle&autonomousRemediation=true",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("err=invalid");
    expect(putBodies).toHaveLength(0);

    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("Invalid audit posture");
    expect(html).toContain('data-current-block-review-at="P1"');
  });

  it("keeps a non-admin denial and unchanged current posture visible", async () => {
    governancePutStatus = 403;
    governancePutError = "org_admin_required";
    const app = await build();
    const response = await postForm(
      app,
      "projectId=project_easy&blockReviewAt=P3&p2p3Handling=route-to-dag&autonomousRemediation=true",
    );
    expect(response.headers.get("location")).toContain("err=forbidden");

    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("org-admin authority is required");
    expect(html).toContain("The posture was not changed");
    expect(html).toContain('data-current-block-review-at="P1"');
  });

  it("keeps an orchestrator server failure and unchanged current posture visible", async () => {
    governancePutStatus = 500;
    const app = await build();
    const response = await postForm(app, "projectId=project_easy&blockReviewAt=P2&p2p3Handling=fix-if-idle");
    expect(response.headers.get("location")).toContain("err=save_failed");

    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("Governance save failed at the orchestrator");
    expect(html).toContain('data-current-block-review-at="P1"');
  });

  it("reloads and explains a concurrent governance conflict", async () => {
    governancePutStatus = 409;
    governancePutError = "project_config_conflict";
    const app = await build();
    const response = await postForm(app, "projectId=project_easy&blockReviewAt=P2&p2p3Handling=fix-if-idle");
    expect(response.headers.get("location")).toContain("err=conflict");

    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("Governance changed concurrently");
    expect(html).toContain("Current values were reloaded");
    expect(html).toContain('data-current-block-review-at="P1"');
  });

  it("renders read failure as unavailable without substituting fake defaults", async () => {
    governanceGetStatus = 500;
    const app = await build();
    const html = await (await app.request("/settings/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-unavailable");
    expect(html).toContain("No defaults were substituted");
    expect(html).not.toContain("data-current-audit-posture");
  });

  it("renders a malformed successful GET as an actionable mounted-screen state", async () => {
    governancePayload = { ...CURRENT_GOVERNANCE, auditPosture: { blockReviewAt: "P1" } };
    const app = await build();
    const response = await app.request("/settings/governance?projectId=project_easy");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("data-governance-malformed");
    expect(html).toContain("Verify orchestrator/dashboard versions");
    expect(html).not.toContain("data-current-audit-posture");
  });

  it("renders malformed successful PUT confirmation as an unknown, actionable save outcome", async () => {
    malformedPutSuccess = true;
    const app = await build();
    const response = await postForm(
      app,
      "projectId=project_easy&blockReviewAt=P3&p2p3Handling=route-to-dag&autonomousRemediation=true",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("err=malformed_save");
    const html = await (await app.request(response.headers.get("location") ?? "/settings/governance")).text();
    expect(html).toContain("acknowledged the save but returned malformed confirmation");
    expect(html).toContain("Treat the outcome as unknown and verify before retrying");
    expect(html).toContain('data-current-block-review-at="P3"');
  });

  it("refuses an unknown project id before any governance write", async () => {
    const app = await build();
    const response = await postForm(
      app,
      "projectId=project_other&blockReviewAt=P3&p2p3Handling=route-to-dag&autonomousRemediation=true",
    );
    expect(response.headers.get("location")).toContain("err=no_project");
    expect(putBodies).toHaveLength(0);
  });
});
