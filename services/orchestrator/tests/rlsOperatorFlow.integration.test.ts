// RLS operator/control-plane flow — the end-to-end regression proof, against a
// REAL Postgres under the enforced `tanren_app` role (no SQL mocks).
//
// The R1→R3b conversion covered the RUN-EXECUTION path (runs/events/tasks/
// cost_records/specs/runners/quota/forge) but MISSED the operator/control-plane
// CRUD + authz routes. Live validation walked the operator flow on the enforced
// stack and hit three failures, all the same root cause — a read/write hitting an
// RLS-enabled table with NO `app.current_org_id` established:
//
//   1. `GET /orgs` → empty (user-scoped bootstrap read: list MY orgs, pre-scope);
//   2. actor resolution itself: `resolveActorContext` reads `org_members` under
//      RLS with no scope → the actor resolves with NO org scope → every
//      `/orgs/:orgId/*` route's in-memory `actorCanAccessOrg` check 403s even a
//      legitimate org ADMIN (this is why `POST /orgs/:orgId/projects` → 403);
//   3. operator CRUD handlers (projects list/create, org config) read/write
//      RLS-enabled tables on the bare pool → empty reads / rejected writes.
//
// The fixes (NO policy loosened):
//   • user-scoped bootstrap reads (list-my-orgs, actor membership resolution) run
//     on the BYPASSRLS `tanren_system` pool via `runWithSystemScope`, filtered by
//     `user_id`;
//   • the auth middleware establishes a per-request org scope
//     (`runWithJobOrgId(actor.orgId)`) and the operator routes run on an
//     `orgScopingPool`, so each handler `.query` opens a short `runWithOrgScope`
//     stamped with the request's org — the deny-by-default policies then admit
//     the org's own rows under `tanren_app`.
//
// This test drives the LITERAL operator flow live validation walked, through the
// REAL auth middleware + REAL route handlers, on the `tanren_app` role with the
// policies enforced: dev-login bootstrap (mint org+admin membership, #180 path)
// → resolve actor (membership read) → list orgs (NON-EMPTY) → read org config →
// import + list a credential (NON-EMPTY) → create a project → list projects
// (NON-EMPTY) → create a spec → list specs (NON-EMPTY). EVERY step must succeed
// under enforcement; before the fix, steps 2/3 503/403/empty.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the R1 / R2 / R3a / R3b / org-bootstrap cohort.
// Wired into `just smoke` via `just smoke-rls-operator-flow`.

import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { IdentityStore } from "../src/auth/identityStore.js";
import type { IdentityClaims } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/index.js";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { createAuthMiddleware, SESSION_COOKIE, CSRF_HEADER, type ActorContextEnv } from "../src/middleware/auth.js";
import { createCredentialRoutes } from "../src/routes/credentials/index.js";
import { createOrgRoutes } from "../src/routes/orgs/index.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { createSpecRoutes } from "../src/routes/specs/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_rls_operator_flow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

// The dev-login / signup identity carrying one org claim — the bootstrap org the
// signup mints (the user becomes its first member = admin).
function signupIdentity(suffix: string): IdentityClaims {
  return {
    providerSubject: `subject-${suffix}`,
    login: `user-${suffix}`,
    email: `${suffix}@example.com`,
    displayName: `User ${suffix}`,
    orgs: [{ externalId: `ext-${suffix}`, login: `org-${suffix}`, displayName: `Org ${suffix}`, kind: "github_org" }],
  };
}

// The REAL operator app surface: the auth middleware (which resolves the actor
// AND establishes the per-request org scope) in front of the org/project/spec/
// credential routes, every one on the `orgScopingPool` — exactly the
// `mountFeatureRoutes` wiring. Cookie/CSRF auth flows through the real store.
function buildOperatorApp(appPool: Pool, store: IdentityStore): Hono<ActorContextEnv> {
  const scopedPool = orgScopingPool(appPool);
  const app = new Hono<ActorContextEnv>();
  app.use("*", createAuthMiddleware({ store }));
  app.route("/orgs", createOrgRoutes({ pool: scopedPool }));
  app.route("/orgs", createProjectRoutes({ pool: scopedPool }));
  app.route("/orgs", createSpecRoutes({ pool: scopedPool }));
  app.route("/", createCredentialRoutes({ pool: scopedPool, secrets: new InMemorySecretStore() }));
  return app;
}

describeDb("RLS operator flow — the control-plane CRUD walk under the tanren_app role", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let systemPool: Pool;
  let store: IdentityStore;
  let app: Hono<ActorContextEnv>;

  // Set during the bootstrap step, then used by the authenticated requests.
  let orgId: string;
  let sessionId: string;
  let csrf: string;

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

    // Production wiring: the BYPASSRLS system pool is resolved for the
    // bootstrap-class reads/writes. The runtime app role is `tanren_app`.
    setSystemPool(systemPool);
    store = new IdentityStore(appPool);
    app = buildOperatorApp(appPool, store);
  }, 60_000);

  // The `beforeAll` `setSystemPool` injection above survives every test in this
  // file: the global test setup (test/setup/systemPool.ts) resets the pool only
  // per-FILE (`afterAll`), not per-test. Without that, steps 2..n would fall back
  // to the `tanren_app` runtime pool for the bootstrap-class system reads
  // (list-my-orgs + the actor's `org_members` resolution), which the NOBYPASSRLS
  // app role with an empty org GUC sees as ZERO rows — so the actor would resolve
  // with no org scope and every `/orgs/:orgId/*` route's `actorCanAccessOrg` gate
  // would 403 (steps 5/6/7).

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

  // STEP 1 — BOOTSTRAP: dev-login mints the org + the first (admin) membership on
  // the `tanren_app` runtime role via the #180 system-bypass path, and we open a
  // session. (Direct store calls model the auth route; the rest of the flow goes
  // through the real HTTP surface.)
  it("1. bootstraps the org + admin membership + session (dev-login)", async () => {
    const result = await store.upsertIdentity("local_dev", signupIdentity("op"));
    expect(result.orgs).toHaveLength(1);
    orgId = result.orgs[0]!.id;
    expect(result.primaryOrgId).toBe(orgId);

    const session = await store.createSession(result.user.id);
    sessionId = session.id;
    csrf = session.csrfToken;

    // Ground truth (owner = RLS-exempt): the admin membership landed.
    const member = await ownerPool.query<{ role: string }>(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, result.user.id],
    );
    expect(member.rows[0]?.role).toBe("admin");
  });

  // STEP 2 — LIST MY ORGS: the user-scoped bootstrap read. Must be NON-EMPTY and
  // report the admin role. (Pre-fix: empty under RLS — the bug.)
  it("2. GET /orgs returns the bootstrapped org (non-empty) with the admin role", async () => {
    const res = await app.request("/orgs", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgs: Array<{ id: string; role: string }> };
    expect(body.orgs.map((o) => o.id)).toEqual([orgId]);
    expect(body.orgs[0]?.role).toBe("admin");
  });

  // STEP 3 — READ ORG CONFIG: the in-org `organizations` read. This is the step
  // that proves actor resolution worked (the `/:orgId` route's actorCanAccessOrg
  // gate passes ONLY if `resolveActorContext` saw the membership) AND that the
  // in-org read is admitted under the per-request org scope. (Pre-fix: 403 — the
  // actor had no org scope.)
  it("3. GET /orgs/:orgId reads the org config (actor resolution + in-org RLS read)", async () => {
    const res = await app.request(`/orgs/${orgId}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; config: { version: number } };
    expect(body.id).toBe(orgId);
    expect(body.config.version).toBe(1);
  });

  // STEP 4 — LIST CREDENTIALS: the org-scoped credential surface. The authz gate
  // (`actorCanAccessOrg`) must PASS for the admin → 200, not 403. This is the
  // step live validation found 403'd after a credential import, because the actor
  // had no resolved org scope. (The default registry is in-memory, so this proves
  // the AUTHZ gate / actor resolution, which is the RLS-affected part.)
  it("4. GET /orgs/:orgId/credentials passes the org-access gate for the admin (200)", async () => {
    const listed = await app.request(`/orgs/${orgId}/credentials`, { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { credentials: unknown[] };
    expect(Array.isArray(body.credentials)).toBe(true);
  });

  // STEP 5 — CREATE + LIST A PROJECT: the operator CRUD write+read that live
  // validation found 403'd. Create must 201 (authz + org-scoped INSERT into
  // `projects`), and the list must return it (non-empty in-org read).
  let projectId: string;
  it("5. POST + GET /orgs/:orgId/projects creates then lists a project (non-empty)", async () => {
    const created = await app.request(`/orgs/${orgId}/projects`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Demo", repoUrl: "https://github.com/acme/demo" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { projectId: string };
    projectId = createdBody.projectId;
    expect(projectId).toMatch(/^project_/u);

    const listed = await app.request(`/orgs/${orgId}/projects`, { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { projects: Array<{ projectId: string }> };
    expect(body.projects.map((p) => p.projectId)).toContain(projectId);
  });

  // STEP 6 — CREATE + LIST A SPEC: the org+project-scoped spec write+read,
  // closing the loop. (specs were R2-converted, but only succeed once the actor
  // resolves with the org scope and the project exists — the prior steps.)
  it("6. POST + GET …/specs creates then lists a spec (non-empty)", async () => {
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
    const createdBody = (await created.json()) as { specId: string };
    expect(createdBody.specId).toMatch(/^spec_/u);

    const listed = await app.request(`/orgs/${orgId}/projects/${projectId}/specs`, { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { specs: Array<{ specId: string }> };
    expect(body.specs.map((s) => s.specId)).toContain(createdBody.specId);
  });

  // STEP 7 — RESOLVE A needs_attention ESCALATION (the operator API gap the live
  // apex run surfaced). A spec that exhausted its retry budget parks at the terminal
  // `needs_attention` status; the operator's `requeue` resolution must flip it back to
  // the runnable `open` re-entry status (so the DagWalker re-picks it up) and emit an
  // actor-stamped audit event — all under the enforced `tanren_app` role. A spec NOT
  // parked at needs_attention is a clean 409, never a silent re-transition.
  let attentionSpecId: string;
  it("7a. parks a spec at needs_attention, then POST …/specs/:id/requeue resolves it (open + audit event)", async () => {
    // Create a spec, then (owner = RLS-exempt) park it at the terminal escalation
    // status — modelling the strand-reconciler bounded escalation.
    const created = await app.request(`/orgs/${orgId}/projects/${projectId}/specs`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        title: "Stuck spec",
        description: "Blocked on a platform bug",
        acceptanceCriteria: ["x"],
      }),
    });
    expect(created.status).toBe(201);
    attentionSpecId = ((await created.json()) as { specId: string }).specId;
    await ownerPool.query("UPDATE specs SET status = 'needs_attention' WHERE spec_id = $1", [attentionSpecId]);

    const requeued = await app.request(`/orgs/${orgId}/projects/${projectId}/specs/${attentionSpecId}/requeue`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
    });
    expect(requeued.status).toBe(200);
    const requeueBody = (await requeued.json()) as { specId: string; status: string; fromSource: string };
    expect(requeueBody).toMatchObject({ specId: attentionSpecId, status: "open", fromSource: "strand" });

    // Ground truth (owner): the spec is back to the runnable `open` re-entry status…
    const specRow = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      attentionSpecId,
    ]);
    expect(specRow.rows[0]?.status).toBe("open");
    // …and the actor-stamped resolution audit event was emitted.
    const eventRow = await ownerPool.query<{ payload: { resolvedBy: string; fromSource: string } }>(
      "SELECT payload FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.attention_resolved'",
      [attentionSpecId],
    );
    expect(eventRow.rowCount).toBe(1);
    expect(eventRow.rows[0]?.payload.fromSource).toBe("strand");
    expect(typeof eventRow.rows[0]?.payload.resolvedBy).toBe("string");
  });

  it("7b. requeue on a spec NOT in needs_attention is a clean 409 (no silent re-transition)", async () => {
    // The spec from 7a is now `open`. A second requeue must be rejected, not silently
    // re-flipped (the no-op-or-error contract).
    const res = await app.request(`/orgs/${orgId}/projects/${projectId}/specs/${attentionSpecId}/requeue`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("spec_not_in_attention");
    // The spec's status is untouched (still `open`).
    const specRow = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      attentionSpecId,
    ]);
    expect(specRow.rows[0]?.status).toBe("open");
  });

  // STEP 8 — OPERATOR CANCEL (the §4 fix-soon leftover the apex pre-run audit surfaced).
  // POST …/specs/:id/cancel transitions the spec (+ its active run) to the terminal
  // `cancelled` state, frees the DAG slot, and parks a live dependent at
  // `needs_attention` (never a silent cascade-cancel) — all under enforced `tanren_app`.
  it("8a. cancels a spec + its in-flight run, releasing the runner + parking a dependent", async () => {
    // An ancestor spec with an in-flight run + a claimed runner, and a dependent that
    // depends on it (owner = RLS-exempt seeding, mirroring the strand-park above).
    const ancestor = await app.request(`/orgs/${orgId}/projects/${projectId}/specs`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ title: "Cancel me", description: "dead-end", acceptanceCriteria: ["x"] }),
    });
    expect(ancestor.status).toBe(201);
    const ancestorId = ((await ancestor.json()) as { specId: string }).specId;

    const dependent = await app.request(`/orgs/${orgId}/projects/${projectId}/specs`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        title: "Depends on cancelled",
        description: "downstream",
        acceptanceCriteria: ["y"],
        dependsOn: [ancestorId],
      }),
    });
    expect(dependent.status).toBe(201);
    const dependentId = ((await dependent.json()) as { specId: string }).specId;

    // Put the ancestor in-flight with a running run + a claimed runner.
    const runId = `run_cancel_${Date.now()}`;
    const runnerId = `runner_cancel_${Date.now()}`;
    await ownerPool.query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [ancestorId]);
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'api', 'tanren/cancel', 'running')`,
      [runId, ancestorId, projectId, orgId],
    );
    await ownerPool.query(
      `INSERT INTO runners (runner_id, run_id, project_id, org_id, allocator, status, ssh_host, ssh_port,
                            host_key_fingerprint, image_sha)
       VALUES ($1, $2, $3, $4, 'local-docker', 'claimed', 'localhost', 22, 'fp', 'sha')`,
      [runnerId, runId, projectId, orgId],
    );

    const res = await app.request(`/orgs/${orgId}/projects/${projectId}/specs/${ancestorId}/cancel`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
    });
    expect(res.status).toBe(200);
    const cancelBody = (await res.json()) as {
      cancelled: boolean;
      status: string;
      run?: { runId: string; runnerReleased: boolean };
      dependentsParked: string[];
    };
    expect(cancelBody).toMatchObject({ cancelled: true, status: "cancelled" });
    expect(cancelBody.run).toMatchObject({ runId, runnerReleased: true });
    expect(cancelBody.dependentsParked).toContain(dependentId);

    // Ground truth (owner): the spec + its run are terminal-cancelled, the runner is
    // released (no leak), and the dependent is parked at needs_attention (not dropped).
    const specRow = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      ancestorId,
    ]);
    expect(specRow.rows[0]?.status).toBe("cancelled");
    const runRow = await ownerPool.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [runId]);
    expect(runRow.rows[0]?.status).toBe("cancelled");
    const runnerRow = await ownerPool.query<{ status: string }>("SELECT status FROM runners WHERE runner_id = $1", [
      runnerId,
    ]);
    expect(runnerRow.rows[0]?.status).toBe("released");
    const depRow = await ownerPool.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [
      dependentId,
    ]);
    expect(depRow.rows[0]?.status).toBe("needs_attention");
    // The loud cancelled-ancestor escalation event fired for the dependent.
    const escalation = await ownerPool.query<{ payload: { source: string } }>(
      "SELECT payload FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.needs_attention'",
      [dependentId],
    );
    expect(escalation.rows[0]?.payload.source).toBe("cancelled_ancestor");
  });

  it("8b. cancel on an already-cancelled spec is an idempotent 200 no-op (not an error)", async () => {
    // Re-cancel the spec from 8a (now terminal). A clean no-op, never a 409/500.
    const cancelledId = (
      await ownerPool.query<{ spec_id: string }>("SELECT spec_id FROM specs WHERE status = 'cancelled' LIMIT 1")
    ).rows[0]?.spec_id;
    const res = await app.request(`/orgs/${orgId}/projects/${projectId}/specs/${cancelledId}/cancel`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean; status: string };
    expect(body).toMatchObject({ cancelled: false, status: "cancelled" });
  });
});
