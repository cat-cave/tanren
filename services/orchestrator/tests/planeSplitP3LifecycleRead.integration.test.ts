// Plane-split — the DagWalker LIFECYCLE READ gap regression, against a REAL
// Postgres (no SQL mocks). This is the residual read-gap PR #269 left open: the
// worker connects as the de-privileged `tanren_dataplane` role (0031 REVOKE ALL
// ON TABLE events), but `PgDagLifecycleReadModel.loadLifecycle` reads `events`
// (the lateral join). #269 routed the walker's WRITES through the control
// plane but left this READ on the dataplane role — so every walk that loaded the
// lifecycle projection threw `permission denied for table events` (42501) from
// BOTH the boot walk and the notification walk.
//
// The fix: the lifecycle read resolves its pool as `getSystemPool() ?? this.pool`
// — the BYPASSRLS `tanren_system` role (which keeps SELECT on `events`) when a
// system URL is configured, exactly as `walker.ts` does for project listing. The
// org scope is STILL applied on top (`runWithOrgScope` sets app.current_org_id),
// so the read stays org-scoped — only the ROLE changes to one that can SELECT.
//
// What this proves (the negative control + the fix together):
//   (a) NEGATIVE CONTROL: the lifecycle lateral-join `events` SELECT, run on the
//       dataplane-role pool under the project's org scope, throws 42501
//       (`permission denied for table events`) — reproducing the exact bug. This
//       proves the dataplane role genuinely cannot SELECT events, so routing the
//       read through the system role is load-bearing.
//   (b) THE FIX: with the system pool wired (the worker's TANREN_SYSTEM_DATABASE_URL),
//       the SAME `PgDagLifecycleReadModel` (constructed on the dataplane pool)
//       loads the lifecycle successfully and returns the right ORG-SCOPED
//       lifecycle for the project's spec — proving the read routes through the
//       system role while org scope is preserved.
//   (c) ORG ISOLATION: the system-pool read is still org-scoped — a project in a
//       DIFFERENT org never leaks its spec into this org's snapshot.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the RLS cohort + P3a/P3b/P3c tests.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { PgDagLifecycleReadModel } from "../src/engine/dag/lifecycle.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_p3lifecycle_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function withRole(url: string, role: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_p3lifecycle";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = `run_${ORG}`;

// A second org/project to prove the system-pool read STAYS org-scoped (no leak).
const OTHER_ORG = "org_p3lifecycle_other";
const OTHER_PROJECT = `proj_${OTHER_ORG}`;
const OTHER_SPEC = `spec_${OTHER_ORG}`;

describeDb("plane-split P3 — the DagWalker lifecycle read uses the system pool (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration set creates `tanren_dataplane` (0031) + REVOKEs ALL on
    // `events`, creates the BYPASSRLS `tanren_system` (0030) which KEEPS SELECT on
    // events, and installs the RLS policies (0030).
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });

    // Seed BOTH orgs' project/spec/run as the OWNER (bypasses RLS as table owner),
    // plus a set of lifecycle events on this org's run so the projection is
    // non-trivial (pr opened + ci passed + merge completed → the merged ladder).
    for (const [org, project, spec] of [
      [ORG, PROJECT, SPEC],
      [OTHER_ORG, OTHER_PROJECT, OTHER_SPEC],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
        [org],
      );
      await ownerPool.query(
        `INSERT INTO projects (project_id, name, repo_url, org_id)
         VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
        [project, org],
      );
      await ownerPool.query(
        `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
         VALUES ($1, $2, $3, 't', 'd', 'in_flight')`,
        [spec, project, org],
      );
    }
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'dag_walker', 'main', 'completed')`,
      [RUN, SPEC, PROJECT, ORG],
    );
    // NATIVE delivery: "ci green" is a PASSING pre-merge native gate verdict, so the
    // ladder uses a gate.verdict (passed, when=pre_merge) — not a forge ci.passed.
    const seeds: Array<{ eventType: string; payload: string }> = [
      { eventType: "github.pr.created", payload: "{}" },
      { eventType: "gate.verdict", payload: JSON.stringify({ when: "pre_merge", passed: true, headSha: "abc" }) },
      { eventType: "merge.completed", payload: "{}" },
    ];
    for (const seed of seeds) {
      await ownerPool.query(
        `INSERT INTO events (run_id, spec_id, project_id, org_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [RUN, SPEC, PROJECT, ORG, seed.eventType, seed.payload],
      );
    }
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await dataPlanePool?.end();
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

  // (a) THE NEGATIVE CONTROL (the exact read PR #269 left on the data plane): the
  // lifecycle lateral join SELECTs `events` UNDER THE PROJECT'S ORG SCOPE. Run
  // that SELECT on the de-privileged data-plane role (the role the worker connects
  // as) and it is rejected for lack of the `events` SELECT grant (42501 /
  // permission denied for table events) — the throw the live worker hit on every
  // walk. (org resolution itself goes through the system pool in the real worker,
  // which is why the read — not the resolve — is the gap; this asserts the read.)
  it("(a) the lifecycle events read on the data-plane role throws 42501 (the bug)", async () => {
    await expect(
      runWithOrgScope(dataPlanePool, ORG, (client) =>
        // The minimal shape of the lifecycle lateral join's `events` read.
        client.query("SELECT bool_or(event_type = 'gate.verdict') FROM events WHERE run_id = $1", [RUN]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // (b) THE FIX: wire the system pool (the worker's TANREN_SYSTEM_DATABASE_URL).
  // The SAME model — still constructed on the data-plane pool — now loads the
  // lifecycle through the BYPASSRLS `tanren_system` role (which CAN SELECT events)
  // and returns the project's spec lifecycle. The org scope is still applied, so
  // the read is the project's own DAG.
  it("(b) WITH the system pool wired, the SAME model loads the lifecycle (the read routes through the system role)", async () => {
    setSystemPool(systemPool);
    try {
      const model = new PgDagLifecycleReadModel(dataPlanePool);
      const snapshot = await model.loadLifecycle(PROJECT);
      expect(snapshot.projectId).toBe(PROJECT);
      const lifecycle = snapshot.bySpecId.get(SPEC);
      expect(lifecycle).toBeDefined();
      // pr opened + ci passed + merge completed ⇒ the projection lands on `merged`.
      expect(lifecycle?.state).toBe("merged");
    } finally {
      setSystemPool(undefined);
    }
  });

  // (c) ORG ISOLATION: the system-pool read is STILL org-scoped (runWithOrgScope
  // sets app.current_org_id even on the BYPASSRLS connection, and the query also
  // filters by project_id). The other org's project/spec never leaks into this
  // org's snapshot, and loading the OTHER project returns only its own spec.
  it("(c) the system-pool read stays org-scoped — no cross-org leak", async () => {
    setSystemPool(systemPool);
    try {
      const model = new PgDagLifecycleReadModel(dataPlanePool);
      const mine = await model.loadLifecycle(PROJECT);
      expect([...mine.bySpecId.keys()]).toEqual([SPEC]);
      expect(mine.bySpecId.has(OTHER_SPEC)).toBe(false);

      const other = await model.loadLifecycle(OTHER_PROJECT);
      expect([...other.bySpecId.keys()]).toEqual([OTHER_SPEC]);
      expect(other.bySpecId.has(SPEC)).toBe(false);
    } finally {
      setSystemPool(undefined);
    }
  });
});
