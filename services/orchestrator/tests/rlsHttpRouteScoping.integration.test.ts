// RLS HTTP-route scoping — the FULL operator→run flow across ALL route shapes,
// against a REAL Postgres under the enforced `tanren_app` role (no SQL mocks).
//
// #181 completed RLS scoping for the operator/control-plane `/orgs/:orgId/*`
// routes (org resolved from the PATH). But the Phase-1 root API handlers are
// RESOURCE-keyed with NO `orgs` path segment — `POST /specs/:specId/runs`,
// `GET /runs/:runId`, `POST /runs/:runId/*` — so the actor resolved with NO org,
// no per-request scope was established, and the handler's tenant-table read came
// back RLS-empty. Live validation on the enforced stack hit exactly this:
// `POST /specs/:specId/runs` → 404 `spec_not_found` for a spec just created.
//
// The fix is middleware-level: `resolveActorForRequest` resolves the request's
// org in precedence path → resource (`resolveRequestOrgFromResource`) → actor's
// sole org, re-checking membership each time (never widening access), and
// establishes the per-request `runWithJobOrgId` scope. The resource-keyed root
// handlers run on an `orgScopingPool` (or self-scope from the now-correct
// `actor.orgId`), so under `tanren_app` the deny-by-default policies admit the
// addressed org's rows.
//
// This test drives the LITERAL flow live validation walked, through the REAL
// auth middleware + REAL route handlers on the enforced `tanren_app` role:
// bootstrap org → list orgs → import + LIST credentials (NON-EMPTY) → create
// project → create spec → trigger run via `POST /specs/:specId/runs` (MUST NOT
// 404) → read run status `GET /runs/:runId` → read run events → recovery surface.
// EVERY step must succeed; before the fix the resource-keyed steps 404/empty.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R1/R2/R3a/R3b/operator-flow cohort. Wired
// into `just smoke` via `just smoke-rls-http-route-scoping`.

import type { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { IdentityStore } from "../src/auth/identityStore.js";
import type { IdentityClaims, IdentityProviderId } from "../src/auth/schemas.js";
import { InMemorySecretStore, type SshSubstrate } from "../src/engine/contracts/index.js";
import { buildApp } from "../src/main.js";
import { SESSION_COOKIE, CSRF_HEADER, type ActorContextEnv } from "../src/middleware/auth.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_rls_http_route_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// A user in TWO orgs — deliberately MULTI-org so the auth middleware's
// "actor's sole org" fallback CANNOT fire for the resource-keyed root routes.
// That forces the resource→org arm (`resolveRequestOrgFromResource`) to be the
// thing that scopes `POST /specs/:specId/runs` + `GET /runs/:runId`: the proof
// that arm — not a single-org shortcut — carries the fix.
function signupIdentity(suffix: string): IdentityClaims {
  return {
    providerSubject: `subject-${suffix}`,
    login: `user-${suffix}`,
    email: `${suffix}@example.com`,
    displayName: `User ${suffix}`,
    orgs: [
      { externalId: `ext-${suffix}-a`, login: `org-${suffix}-a`, displayName: `Org ${suffix} A`, kind: "github_org" },
      { externalId: `ext-${suffix}-b`, login: `org-${suffix}-b`, displayName: `Org ${suffix} B`, kind: "github_org" },
    ],
  };
}

// The draft-pr route reads `ssh` — this test exercises neither it nor the
// substrate, so a never-invoked stub satisfies the dep shape.
const ssh = { run: async () => ({}) } as unknown as SshSubstrate;

// The REAL production app — `buildApp` wires the auth middleware (now resolving
// the actor + establishing the per-request org scope INCLUDING the resource→org
// arm via `pool`) in front of BOTH the `/orgs/:orgId/*` operator routes AND the
// resource-keyed root API routes (`mountRootApiRoutes`), every one on the
// `orgScopingPool`. Using `buildApp` (not a hand-mounted subset) tests the exact
// wiring shipped. An empty providers map keeps the auth ROUTES inert; the test
// drives cookie/CSRF auth straight through the real store.
function buildFlowApp(appPool: Pool, store: IdentityStore): Hono<ActorContextEnv> {
  return buildApp({
    pool: appPool,
    secrets: new InMemorySecretStore(),
    vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    auth: {
      store,
      providers: new Map<IdentityProviderId, never>(),
      publicBaseUrl: "http://localhost",
    },
    ssh,
  }) as Hono<ActorContextEnv>;
}

describeDb("RLS HTTP-route scoping — the full operator→run flow across all route shapes", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;
  let store: IdentityStore;
  let app: Hono<ActorContextEnv>;

  let orgId: string;
  let sessionId: string;
  let csrf: string;
  let projectId: string;
  let specId: string;
  let runId: string;

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { cookie: `${SESSION_COOKIE}=${sessionId}`, [CSRF_HEADER]: csrf, ...extra };
  }

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });

    setSystemPool(systemPool);
    store = new IdentityStore(appPool);
    app = buildFlowApp(appPool, store);
  }, 60_000);

  afterAll(async () => {
    setSystemPool(undefined);
    await appPool?.end();
    await systemPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // STEP 1 — BOOTSTRAP: dev-login mints the org + first (admin) membership on the
  // runtime role via the #180 system-bypass path; open a session.
  it("1. bootstraps TWO orgs + admin membership + session", async () => {
    const result = await store.upsertIdentity("local_dev", signupIdentity("http"));
    expect(result.orgs).toHaveLength(2);
    // The flow operates entirely within the FIRST org; the second exists only to
    // make the user multi-org (so the sole-org fallback is inapplicable).
    orgId = result.orgs[0]!.id;
    const session = await store.createSession(result.user.id);
    sessionId = session.id;
    csrf = session.csrfToken;
  });

  // STEP 2 — LIST MY ORGS: the user-scoped bootstrap read (system-scoped). Must
  // be NON-EMPTY and report BOTH orgs (confirming the user is multi-org, so the
  // resource→org arm — not the sole-org fallback — scopes the resource routes).
  it("2. GET /orgs returns both bootstrapped orgs (non-empty, multi-org)", async () => {
    const res = await app.request("/orgs", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgs: Array<{ id: string }> };
    expect(body.orgs).toHaveLength(2);
    expect(body.orgs.map((o) => o.id)).toContain(orgId);
  });

  // STEP 3 — IMPORT + LIST CREDENTIALS: the org-scoped credential surface. Import
  // via `POST /orgs/:orgId/credentials` (registers under `{scope:org, ownerId}`),
  // then `GET /orgs/:orgId/credentials` must list it NON-EMPTY within the process.
  // (This is the surface that survives import within a process; the legacy
  // top-level import endpoints are Vault-only and intentionally unregistered.)
  it("3. imports a credential then lists it (non-empty)", async () => {
    const imported = await app.request(`/orgs/${orgId}/credentials?kind=opaque`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ ref: "demo", value: "s3cr3t" }),
    });
    expect(imported.status).toBe(201);

    const listed = await app.request(`/orgs/${orgId}/credentials`, { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { credentials: Array<{ ref: string }> };
    expect(body.credentials.length).toBeGreaterThan(0);
    expect(body.credentials.some((cred) => cred.ref.endsWith("/demo"))).toBe(true);
  });

  // STEP 4 — CREATE PROJECT (org-keyed write).
  it("4. POST /orgs/:orgId/projects creates a project", async () => {
    const created = await app.request(`/orgs/${orgId}/projects`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Demo", repoUrl: "https://github.com/acme/demo" }),
    });
    expect(created.status).toBe(201);
    projectId = ((await created.json()) as { projectId: string }).projectId;
    expect(projectId).toMatch(/^project_/u);
  });

  // STEP 5 — CREATE SPEC (org+project-keyed write).
  it("5. POST …/specs creates a spec", async () => {
    const created = await app.request(`/orgs/${orgId}/projects/${projectId}/specs`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        title: "First spec",
        description: "Do the thing",
        acceptanceCriteria: ["it works"],
      }),
    });
    expect(created.status).toBe(201);
    specId = ((await created.json()) as { specId: string }).specId;
    expect(specId).toMatch(/^spec_/u);
  });

  // STEP 6 — TRIGGER RUN via the RESOURCE-KEYED root route. This is THE live
  // failure: `POST /specs/:specId/runs` has no `:orgId`, so pre-fix the spec read
  // was RLS-empty → 404 `spec_not_found` for a spec just created. The middleware
  // resolves the org from `specs.org_id` keyed by the path id, so it MUST 201.
  it("6. POST /specs/:specId/runs triggers a run (MUST NOT 404)", async () => {
    const triggered = await app.request(`/specs/${specId}/runs`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(triggered.status).toBe(201);
    const body = (await triggered.json()) as { runId: string; specId: string };
    expect(body.specId).toBe(specId);
    runId = body.runId;
    expect(runId).toMatch(/^run_/u);
  });

  // STEP 7 — READ RUN STATUS via the RESOURCE-KEYED root route. `GET /runs/:runId`
  // resolves the run's org via the system scope then reads under it; must return
  // the queued run (NON-EMPTY), not 404.
  it("7. GET /runs/:runId reads the run status (no 404)", async () => {
    const res = await app.request(`/runs/${runId}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { run_id: string; status: string } };
    expect(body.run.run_id).toBe(runId);
    expect(body.run.status).toBe("queued");
  });

  // STEP 8 — READ RUN EVENTS via the org-keyed run route (RLS-scoped read).
  it("8. GET …/runs/:runId/events reads the run's events (no 404/403)", async () => {
    const res = await app.request(`/orgs/${orgId}/projects/${projectId}/runs/${runId}/events`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
  });

  // STEP 9 — RECOVERY SURFACE via the org-keyed recovery route. The recovery
  // context read must reach the run under the per-request org scope (no 404/403).
  it("9. GET …/runs/:runId/recovery reads the recovery context (no 404/403)", async () => {
    const res = await app.request(`/orgs/${orgId}/projects/${projectId}/runs/${runId}/recovery`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe(runId);
  });
});
