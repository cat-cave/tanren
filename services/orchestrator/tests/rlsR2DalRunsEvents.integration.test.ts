// RLS wave R2 cohort-1 — runs + events DAL conversion, proven against a REAL
// Postgres (no SQL mocks).
//
// R2 cohort-1 routes the runs + events read/write query sites through R1's
// org-scoped client (`runWithOrgScope` → `getOrgScopedClient()`), so each tenant
// query executes inside a `SET LOCAL app.current_org_id = <org>` transaction.
// (Updated for R3b: the migration now ENABLES the policies, so the org-scoped
// client returns the org's rows while the raw runtime pool is deny-by-default;
// the baselines below compare against the OWNER pool, which is RLS-exempt.)
// These tests prove that end-to-end:
//   (a) the runs read loaders return the org's rows when run on the org-scoped
//       client, identical to the raw pool;
//   (b) the events read loaders (snapshot / page / feed) do the same;
//   (c) the events WRITE recorder (`PgEventStore` handed the pool) routes the
//       INSERT through the ambient org-scoped client when a scope is open, AND
//       falls back to the pool — same committed row — when none is (the inert
//       fallback the DAL seam promises);
//   (d) the DAL seam `resolveQueryClient` returns the ambient scoped client
//       inside a scope and the pool outside one.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 test. Wired into `just smoke` via the same gate.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../src/auth/schemas.js";
import { MissingOrgScopeError, resolveQueryClient } from "../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import {
  fetchEventsPage,
  fetchFeedPage,
  fetchRunEventsForSnapshot,
  fetchRunListItems,
  fetchRunSummary,
} from "../src/routes/runs/list.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_rls_a";
const ORG_B = "org_rls_b";
const PROJECT_A = `proj_${ORG_A}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_a";

// An org-A actor for the read loaders that take an ActorContext (redaction).
const actorA: ActorContext = {
  userId: "user_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

describeDb("RLS R2 cohort-1 — runs + events through the org-scoped client", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    // Seed two orgs; only org A gets a run + a seeded event so the loaders have
    // rows to return. (Org B exists to prove the app-layer org predicate still
    // scopes results — the belt-and-suspenders filter we kept.)
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, `proj_${ORG_B}`, `spec_${ORG_B}`, "run_b");
    // One run.started event for org A's run, written by the owner via the
    // event store (project → org_id derivation), so the read loaders see it.
    // The event store routes its write through the org-scoped seam, which now
    // FAILS LOUDLY without an ambient scope, so the seed runs under org A's scope
    // (the owner pool is RLS-exempt, so the GUC is harmless but the scope is what
    // the seam requires).
    await runWithOrgScope(ownerPool, ORG_A, () =>
      new PgEventStore(ownerPool).append({
        runId: RUN_A,
        specId: SPEC_A,
        projectId: PROJECT_A,
        eventType: "run.started",
        payload: { status: "running" },
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // (d) The DAL seam: ambient scoped client inside a scope, a LOUD throw outside one
  //     (no silent bare-pool fallback for an unscoped tenant op).
  it("(d) resolveQueryClient returns the scoped client in-scope and throws out of scope", async () => {
    expect(() => resolveQueryClient(runtimePool)).toThrow(MissingOrgScopeError);

    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      expect(resolveQueryClient(runtimePool)).toBe(client);
      // And the scoped client carries the org GUC the loaders will run under.
      const { rows } = await client.query<{ org: string }>("SELECT current_setting('app.current_org_id', true) AS org");
      expect(rows[0]?.org).toBe(ORG_A);
    });
  });

  // (a) runs read loaders, through the org-scoped client, return the org's rows
  //     — equal to the OWNER (RLS-exempt) ground truth. Under R3b the policies
  //     are enabled, so the baseline is the owner pool, not the raw runtime pool
  //     (which is now deny-by-default).
  it("(a) runs reads via the org-scoped client match the owner baseline, scoped to the org", async () => {
    const scopedSummary = await runWithOrgScope(runtimePool, ORG_A, (client) => fetchRunSummary(client, RUN_A, ORG_A));
    const ownerSummary = await fetchRunSummary(ownerPool, RUN_A, ORG_A);
    expect(scopedSummary).toEqual(ownerSummary);
    expect(scopedSummary?.runId).toBe(RUN_A);
    // The SAME read on the raw runtime pool (empty GUC) is now denied (R3b).
    const poolSummary = await fetchRunSummary(runtimePool, RUN_A, ORG_A);
    expect(poolSummary).toBeUndefined();

    const scopedList = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchRunListItems(client, { projectId: PROJECT_A, orgId: ORG_A, status: undefined, specId: undefined }),
    );
    expect(scopedList.map((r) => r.runId)).toEqual([RUN_A]);

    // The app-layer org predicate still scopes results: org A's actor querying
    // org B's run via the scoped client gets nothing (belt-and-suspenders).
    const crossOrg = await runWithOrgScope(runtimePool, ORG_A, (client) => fetchRunSummary(client, "run_b", ORG_A));
    expect(crossOrg).toBeUndefined();
  });

  // (b) events read loaders, through the org-scoped client, equal the OWNER
  //     (RLS-exempt) baseline. Under R3b the raw runtime pool is deny-by-default.
  it("(b) events reads via the org-scoped client match the owner baseline", async () => {
    const scopedSnap = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchRunEventsForSnapshot(client, { runId: RUN_A, orgId: ORG_A, limit: 50, actor: actorA, rawView: false }),
    );
    const ownerSnap = await fetchRunEventsForSnapshot(ownerPool, {
      runId: RUN_A,
      orgId: ORG_A,
      limit: 50,
      actor: actorA,
      rawView: false,
    });
    expect(scopedSnap.map((e) => e.eventType)).toEqual(ownerSnap.map((e) => e.eventType));
    expect(scopedSnap.some((e) => e.eventType === "run.started")).toBe(true);
    // The raw runtime pool (empty GUC) now returns zero events (R3b enforcement).
    const poolSnap = await fetchRunEventsForSnapshot(runtimePool, {
      runId: RUN_A,
      orgId: ORG_A,
      limit: 50,
      actor: actorA,
      rawView: false,
    });
    expect(poolSnap).toHaveLength(0);

    const scopedPage = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchEventsPage(client, {
        runId: RUN_A,
        orgId: ORG_A,
        cursor: undefined,
        pageSize: undefined,
        actor: actorA,
        rawView: false,
      }),
    );
    expect(scopedPage.items.some((e) => e.eventType === "run.started")).toBe(true);

    const scopedFeed = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      fetchFeedPage(client, {
        projectId: PROJECT_A,
        orgId: ORG_A,
        cursor: undefined,
        pageSize: undefined,
        actor: actorA,
        rawView: false,
      }),
    );
    expect(scopedFeed.items.some((e) => e.eventType === "run.started")).toBe(true);
  });

  // (c) events WRITE recorder routes through the ambient scope. The out-of-scope
  //     pool fallback is now REJECTED LOUDLY at the DAL seam (MissingOrgScopeError)
  //     — strictly stronger than the prior R3b DB-level deny: an unscoped tenant
  //     write never even reaches Postgres, so it can never silently land.
  it("(c) PgEventStore(pool) writes through the ambient scope; the pool fallback throws loudly", async () => {
    const before = await countEvents(ownerPool, RUN_A);

    // In-scope: the append runs on the ambient org-scoped client. We prove that
    // by appending inside the scope and observing the new row inside the SAME
    // transaction (only visible if the INSERT used that client).
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      await new PgEventStore(runtimePool).append({
        runId: RUN_A,
        specId: SPEC_A,
        projectId: PROJECT_A,
        eventType: "run.completed",
        payload: { status: "completed", outcome: "scoped" },
      });
      const within = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM events WHERE run_id = $1 AND event_type = 'run.completed'",
        [RUN_A],
      );
      expect(Number(within.rows[0]?.n)).toBe(1);
    });

    // Out-of-scope: the same store handed the pool has NO ambient scope, so the
    // DAL seam refuses the unscoped tenant write LOUDLY (it never reaches the DB's
    // WITH CHECK) — the no-silent-fallback guarantee.
    await expect(
      new PgEventStore(runtimePool).append({
        runId: RUN_A,
        specId: SPEC_A,
        projectId: PROJECT_A,
        eventType: "run.completed",
        payload: { status: "completed", outcome: "pool" },
      }),
    ).rejects.toThrow(MissingOrgScopeError);

    // Only the in-scope append landed (owner pool = RLS-exempt ground truth).
    const after = await countEvents(ownerPool, RUN_A);
    expect(after - before).toBe(1);
  });
});

async function countEvents(pool: Pool, runId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM events WHERE run_id = $1", [runId]);
  return Number(rows[0]?.n ?? 0);
}

// Seed an org + project + spec + run for a tenant, as the owner pool. Mirrors
// the R1 test's seeder; kept local so the two cohorts stay independent.
async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description)
     VALUES ($1, $2, $3, 't', 'd')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
