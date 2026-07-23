// CSRF write-regression (#838): every state-changing BFF/form POST rejects
// missing/wrong CSRF (403) and accepts a valid x-csrf-token (not 403). Models
// inboundCsrf.test.ts; inventory covers every app.post in services/dashboard/src.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const SESSION_COOKIE = "tanren_session=sess-csrf-write-regression";
const CSRF = "csrf-secret-token-bbbbbbbb";
const BAD_CSRF = "csrf-wrong-token-zzzzzzzz";

interface WriteEndpoint {
  readonly name: string;
  readonly path: string;
  readonly bodyKind: "form" | "json";
  readonly body: string;
}

// Every app.post(...) mount under services/dashboard/src — extend when adding POSTs.
const WRITE_ENDPOINTS: readonly WriteEndpoint[] = [
  // forge BFF
  {
    name: "POST /forge/tools",
    path: "/forge/tools",
    bodyKind: "json",
    body: JSON.stringify({ orgId: "org_acme", tool: "tanren.noop", args: {} }),
  },
  {
    name: "POST /forge/ask",
    path: "/forge/ask",
    bodyKind: "json",
    body: JSON.stringify({ orgId: "org_acme", question: "status?" }),
  },
  {
    name: "POST /forge/project-narration",
    path: "/forge/project-narration",
    bodyKind: "json",
    body: JSON.stringify({ orgId: "org_acme", projectId: "project_easy" }),
  },
  {
    name: "POST /forge/proposals/approve",
    path: "/forge/proposals/approve",
    bodyKind: "json",
    body: JSON.stringify({ orgId: "org_acme", proposalId: "prop_1" }),
  },
  {
    name: "POST /forge/proposals/reject",
    path: "/forge/proposals/reject",
    bodyKind: "json",
    body: JSON.stringify({ orgId: "org_acme", proposalId: "prop_1" }),
  },
  // budget
  {
    name: "POST /budget",
    path: "/budget",
    bodyKind: "form",
    body: "action=save&ceilingUsd=10&period=monthly&projectId=project_easy",
  },
  // projects / specs / insights / routing
  {
    name: "POST /projects/:projectId/specs",
    path: "/projects/project_easy/specs",
    bodyKind: "form",
    body: "title=t&description=d&acceptanceCriteria=a",
  },
  {
    name: "POST /projects/:projectId/insights/act",
    path: "/projects/project_easy/insights/act",
    bodyKind: "form",
    body: "orgId=org_acme&tool=tanren.acknowledge_insight&args=%7B%7D",
  },
  {
    name: "POST /settings/routing/:projectId/add",
    path: "/settings/routing/project_easy/add",
    bodyKind: "form",
    body: "cli=codex&model=default&authRef=credential/codex/org/o1/d",
  },
  {
    name: "POST /settings/routing/:projectId/remove",
    path: "/settings/routing/project_easy/remove",
    bodyKind: "form",
    body: "index=0",
  },
  {
    name: "POST /settings/routing/:projectId/reorder",
    path: "/settings/routing/project_easy/reorder",
    bodyKind: "form",
    body: "from=0&to=1",
  },
  {
    name: "POST /settings/routing/:projectId/credentials",
    path: "/settings/routing/project_easy/credentials",
    bodyKind: "form",
    body: "githubCredentialRef=credential/github/org/o1/ci",
  },
  // runs
  {
    name: "POST /projects/:projectId/specs/:specId/run",
    path: "/projects/project_easy/specs/spec_1/run",
    bodyKind: "form",
    body: "",
  },
  {
    name: "POST /runs/:runId/review/request-changes",
    path: "/runs/run_1/review/request-changes",
    bodyKind: "form",
    body: "comment=please+fix",
  },
  {
    name: "POST /runs/:runId/review/sign-off",
    path: "/runs/run_1/review/sign-off",
    bodyKind: "form",
    body: "",
  },
  {
    name: "POST /runs/:runId/recover/revise",
    path: "/runs/run_1/recover/revise",
    bodyKind: "form",
    body: "guidance=tweak",
  },
  {
    name: "POST /runs/:runId/recover/replan",
    path: "/runs/run_1/recover/replan",
    bodyKind: "form",
    body: "steering=pivot",
  },
  {
    name: "POST /runs/:runId/recover/rollback",
    path: "/runs/run_1/recover/rollback",
    bodyKind: "form",
    body: "commitSha=abc123",
  },
  {
    name: "POST /runs/:runId/recover/inspection-thread",
    path: "/runs/run_1/recover/inspection-thread",
    bodyKind: "form",
    body: "",
  },
  // inbox
  {
    name: "POST /inbox/candidates/:id/fold",
    path: "/inbox/candidates/cand_1/fold",
    bodyKind: "form",
    body: "orgId=org_acme&runId=run_1",
  },
  {
    name: "POST /inbox/candidates/:id/dismiss",
    path: "/inbox/candidates/cand_1/dismiss",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  {
    name: "POST /inbox/candidates/:id/close-duplicate",
    path: "/inbox/candidates/cand_1/close-duplicate",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  {
    name: "POST /inbox/sources/:id/recover",
    path: "/inbox/sources/src_1/recover",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  // integrations
  {
    name: "POST /integrations/select",
    path: "/integrations/select",
    bodyKind: "form",
    body: "orgId=org_acme&integrationId=int_1",
  },
  {
    name: "POST /integrations/link",
    path: "/integrations/link",
    bodyKind: "form",
    body: "orgId=org_acme&provider=github",
  },
  {
    name: "POST /integrations/select-principal",
    path: "/integrations/select-principal",
    bodyKind: "form",
    body: "orgId=org_acme&principalId=principal_1",
  },
  {
    name: "POST /integrations/enable",
    path: "/integrations/enable",
    bodyKind: "form",
    body: "orgId=org_acme&projectId=project_easy&capability=deploy",
  },
  // audits
  {
    name: "POST /audits",
    path: "/audits",
    bodyKind: "form",
    body: "orgId=org_acme&name=nightly",
  },
  {
    name: "POST /audits/:jobId/enable",
    path: "/audits/job_1/enable",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  {
    name: "POST /audits/:jobId/disable",
    path: "/audits/job_1/disable",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  {
    name: "POST /audits/:jobId/run",
    path: "/audits/job_1/run",
    bodyKind: "form",
    body: "orgId=org_acme",
  },
  // discovery / design / behavior-coverage
  {
    name: "POST /projects/:projectId/discovery",
    path: "/projects/project_easy/discovery",
    bodyKind: "form",
    body: "action=classify",
  },
  {
    name: "POST /projects/:projectId/discovery/accept",
    path: "/projects/project_easy/discovery/accept",
    bodyKind: "form",
    body: "proposalId=prop_1",
  },
  {
    name: "POST /projects/:projectId/design-studio/bind",
    path: "/projects/project_easy/design-studio/bind",
    bodyKind: "form",
    body: "personaId=persona_1",
  },
  {
    name: "POST /projects/:projectId/behavior-coverage/analyze",
    path: "/projects/project_easy/behavior-coverage/analyze",
    bodyKind: "form",
    body: "",
  },
  {
    name: "POST /projects/:projectId/behavior-coverage/verify",
    path: "/projects/project_easy/behavior-coverage/verify",
    bodyKind: "form",
    body: "behaviorId=beh_1",
  },
  // governance
  {
    name: "POST /settings/governance",
    path: "/settings/governance",
    bodyKind: "form",
    body: "orgId=org_acme&auditPosture=strict",
  },
  {
    name: "POST /governance/revisions",
    path: "/governance/revisions",
    bodyKind: "form",
    body: "orgId=org_acme&body=%7B%7D",
  },
  {
    name: "POST /governance/revisions/activate",
    path: "/governance/revisions/activate",
    bodyKind: "form",
    body: "orgId=org_acme&revisionId=rev_1",
  },
  {
    name: "POST /governance/tiers/bind",
    path: "/governance/tiers/bind",
    bodyKind: "form",
    body: "orgId=org_acme&projectId=project_easy&tier=medium",
  },
  // config
  {
    name: "POST /settings/config/toggle",
    path: "/settings/config/toggle",
    bodyKind: "form",
    body: "orgId=org_acme&key=demo&value=1",
  },
  // merge queue
  {
    name: "POST /merge-queue/commands/:command",
    path: "/merge-queue/commands/pause",
    bodyKind: "form",
    body: "orgId=org_acme&projectId=project_easy",
  },
  // onboarding / notifications / credentials
  {
    name: "POST /onboarding/new",
    path: "/onboarding/new",
    bodyKind: "form",
    body: "step=1&orgId=org_acme",
  },
  {
    name: "POST /onboarding/existing/link",
    path: "/onboarding/existing/link",
    bodyKind: "form",
    body: "orgId=org_acme&repoUrl=https://github.com/example/repo",
  },
  {
    name: "POST /onboarding/existing",
    path: "/onboarding/existing",
    bodyKind: "form",
    body: "orgId=org_acme&projectId=project_easy",
  },
  {
    name: "POST /onboarding/credentials/org/apikey",
    path: "/onboarding/credentials/org/apikey",
    bodyKind: "form",
    body: "orgId=org_acme&provider=openrouter&apiKey=sk-x",
  },
  {
    name: "POST /onboarding/credentials/dev/codex",
    path: "/onboarding/credentials/dev/codex",
    bodyKind: "form",
    body: "authJson=%7B%7D",
  },
  {
    name: "POST /onboarding/credentials/github",
    path: "/onboarding/credentials/github",
    bodyKind: "form",
    body: "orgId=org_acme&token=ghp_x",
  },
  {
    name: "POST /onboarding/ai-provider/connect",
    path: "/onboarding/ai-provider/connect",
    bodyKind: "form",
    body: "orgId=org_acme&provider=openrouter&apiKey=sk-x",
  },
  {
    name: "POST /onboarding/credentials/delete",
    path: "/onboarding/credentials/delete",
    bodyKind: "form",
    body: "orgId=org_acme&ref=credential/openrouter/org/o1/d",
  },
  {
    name: "POST /notifications/targets",
    path: "/notifications/targets",
    bodyKind: "form",
    body: "orgId=org_acme&channel=ntfy&address=topic",
  },
  {
    name: "POST /notifications/targets/update",
    path: "/notifications/targets/update",
    bodyKind: "form",
    body: "orgId=org_acme&targetId=t1&address=topic2",
  },
  {
    name: "POST /notifications/routes",
    path: "/notifications/routes",
    bodyKind: "form",
    body: "orgId=org_acme&event=run.failed&targetId=t1",
  },
  {
    name: "POST /onboarding/org/infra",
    path: "/onboarding/org/infra",
    bodyKind: "form",
    body: "orgId=org_acme&allocator=sidecar",
  },
];

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

/** Orchestrator non-GET count — must stay flat when CSRF rejects. */
let orchestratorWrites = 0;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers["cookie"] ?? headers["Cookie"] ?? "";
    if (url.endsWith("/auth/me")) {
      if (!cookie.includes("tanren_session=")) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      }
      return new Response(JSON.stringify({ userId: "u1", csrfToken: CSRF, expiresAt: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
      });
    }
    if (method !== "GET" && method !== "HEAD") orchestratorWrites += 1;
    return new Response(JSON.stringify({ ok: true, orgs: [], projects: [] }), { status: 200 });
  });
}

async function post(
  app: Awaited<ReturnType<typeof createApp>>,
  endpoint: WriteEndpoint,
  headers: Record<string, string>,
): Promise<Response> {
  const contentType = endpoint.bodyKind === "json" ? "application/json" : "application/x-www-form-urlencoded";
  return app.request(endpoint.path, {
    method: "POST",
    headers: { cookie: SESSION_COOKIE, "content-type": contentType, ...headers },
    body: endpoint.body,
    redirect: "manual",
  });
}

beforeEach(() => {
  delete process.env["TANREN_REQUIRE_AUTH"];
  orchestratorWrites = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["TANREN_REQUIRE_AUTH"];
});

describe("CSRF write regression — every state-changing BFF/form POST", () => {
  it("inventory is non-empty (guard against accidental empty table)", () => {
    expect(WRITE_ENDPOINTS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(WRITE_ENDPOINTS)("$name rejects missing csrf (403, no orchestrator write)", async (endpoint) => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const before = orchestratorWrites;
    const res = await post(app, endpoint, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_token_invalid");
    expect(orchestratorWrites).toBe(before);
  });

  it.each(WRITE_ENDPOINTS)("$name rejects wrong csrf (403, no orchestrator write)", async (endpoint) => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const before = orchestratorWrites;
    const res = await post(app, endpoint, { "x-csrf-token": BAD_CSRF });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_token_invalid");
    expect(orchestratorWrites).toBe(before);
  });

  it.each(WRITE_ENDPOINTS)("$name accepts valid x-csrf-token (not 403)", async (endpoint) => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const res = await post(app, endpoint, { "x-csrf-token": CSRF });
    // Gate passed: handler may 200/302/4xx/5xx; never csrf_token_invalid.
    expect(res.status).not.toBe(403);
  });

  it.each(["csrf", "csrfToken"] as const)("form field %s is accepted on POST /budget", async (field) => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const res = await app.request("/budget", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `${field}=${CSRF}&action=save&ceilingUsd=10&period=monthly&projectId=project_easy`,
      redirect: "manual",
    });
    expect(res.status).not.toBe(403);
  });
});
