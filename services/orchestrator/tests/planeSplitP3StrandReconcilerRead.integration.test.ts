// Plane-split — the NEVER-STRAND reconciler event read, against a REAL Postgres
// (no SQL mocks). The worker connects as the de-privileged `tanren_dataplane`
// role: event WRITES stay denied, but event READS are permitted under RLS so the
// reconciler can inspect prior `dag.spec.unstranded` signals without bypassing
// tenant policy.
//
// The fix mirrors the lifecycle read: the events COUNT resolves its pool as
// `getSystemPool() ?? this.pool` — the BYPASSRLS `tanren_system` role (which keeps
// SELECT on `events`) when a system URL is configured. The org scope is STILL
// applied on top (`runWithOrgScope` sets app.current_org_id), so the read stays
// org-scoped — only the ROLE changes to one that can SELECT events.
//
// What this proves:
//   (a) the `countPriorUnstrands` `events` COUNT, run on the dataplane-role pool
//       under the project's org scope, is admitted by table grants and filtered by
//       RLS.
//   (b) THE FIX: with the system pool wired (the worker's TANREN_SYSTEM_DATABASE_URL),
//       the SAME `PgSpecStrandReadModel` (constructed on the dataplane pool) counts
//       the prior unstranded events successfully and returns the right ORG-SCOPED
//       count — proving the read routes through the system role while the query
//       keeps its own tenant/project predicates for BYPASSRLS safety.
//   (c) ORG ISOLATION: the system-pool read is still tenant/project-bounded — a
//       mismatched project/spec pair across orgs never leaks the other org's events
//       into this count.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the
// migration role), exactly like the RLS cohort + P3a/P3b/P3c tests and the
// lifecycle-read regression (planeSplitP3LifecycleRead.integration.test.ts).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { PgSpecStrandReadModel } from "../src/engine/dag/specStrandReconcilerPg.js";
import { PgEventStore } from "../src/engine/eventStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const DATAPLANE_ROLE = "tanren_dataplane";
const DATAPLANE_PASSWORD = process.env["TANREN_DATAPLANE_DB_PASSWORD"] ?? "tanren_dataplane";
const SYSTEM_ROLE = "tanren_system";
const SYSTEM_PASSWORD = process.env["TANREN_SYSTEM_DB_PASSWORD"] ?? "tanren_system";

function dbName(): string {
  return `tanren_p3strand_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG = "org_p3strand";
const PROJECT = `proj_${ORG}`;
const SPEC = `spec_${ORG}`;
const RUN = `run_${ORG}`;

// A second org/project/spec to prove the system-pool read STAYS org-scoped (no
// leak): its unstranded events must never count toward this org's spec.
const OTHER_ORG = "org_p3strand_other";
const OTHER_PROJECT = `proj_${OTHER_ORG}`;
const OTHER_SPEC = `spec_${OTHER_ORG}`;

describeDb("plane-split P3 — the strand reconciler events read uses the system pool (real PG)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let dataPlanePool: Pool;
  let systemPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // The REAL migration set creates `tanren_dataplane`, denies event writes while
    // keeping RLS-scoped event reads, creates the BYPASSRLS `tanren_system`, and
    // installs the RLS policies.
    await migrate(ownerPool);

    dataPlanePool = new Pool({ connectionString: withRole(ADMIN_URL, DATAPLANE_ROLE, DATAPLANE_PASSWORD, database) });
    systemPool = new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) });

    // Seed BOTH orgs' project/spec as the OWNER (bypasses RLS as table owner). This
    // org's spec gets TWO prior `dag.spec.unstranded` events (the attempt-cap key);
    // the OTHER org gets its own spec with one unstranded event — a cross-org leak
    // (a missing org scope) would surface the other org's events in this count.
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
    // This org's spec: two prior unstranded events. The other org's spec: one —
    // which must never bleed into this org's count.
    for (const [spec, project, org, n] of [
      [SPEC, PROJECT, ORG, 2],
      [OTHER_SPEC, OTHER_PROJECT, OTHER_ORG, 1],
    ] as const) {
      await runWithOrgScope(ownerPool, org, async (client) => {
        const events = new PgEventStore(client);
        for (let i = 0; i < n; i++) {
          await events.append({
            specId: spec,
            projectId: project,
            eventType: "dag.spec.unstranded",
            payload: {
              specId: spec,
              reason: "no_live_run",
              terminalRuns: [],
              attempt: i + 1,
            },
          });
        }
      });
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

  // (a) The prior-unstranded COUNT SELECTs `events` under the project's org scope.
  // The data-plane role must be able to read those signals; off-org rows remain
  // filtered by the RLS policy.
  it("(a) the prior-unstranded events count on the data-plane role is RLS-admitted", async () => {
    await expect(
      runWithOrgScope(dataPlanePool, ORG, (client) =>
        client.query("SELECT count(*) FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.unstranded'", [SPEC]),
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
  });

  // (b) THE FIX: wire the system pool (the worker's TANREN_SYSTEM_DATABASE_URL). The
  // SAME model — still constructed on the data-plane pool — now counts the prior
  // unstranded events through the BYPASSRLS `tanren_system` role (which CAN SELECT
  // events) and returns this org's count (2). The org scope is still applied.
  it("(b) WITH the system pool wired, the SAME model counts prior unstrands (the read routes through the system role)", async () => {
    setSystemPool(systemPool);
    try {
      const model = new PgSpecStrandReadModel(dataPlanePool);
      const count = await model.countPriorUnstrands({ projectId: PROJECT, specId: SPEC });
      expect(count).toBe(2);
    } finally {
      setSystemPool(undefined);
    }
  });

  // (c) ORG ISOLATION: the system-pool read is STILL tenant/project-bounded even
  // though tanren_system bypasses RLS. Counting a mismatched project/spec pair
  // across orgs returns zero, and matching pairs still return their own counts.
  it("(c) the system-pool read stays org-scoped — no cross-org leak", async () => {
    setSystemPool(systemPool);
    try {
      const model = new PgSpecStrandReadModel(dataPlanePool);
      expect(await model.countPriorUnstrands({ projectId: PROJECT, specId: SPEC })).toBe(2);
      expect(await model.countPriorUnstrands({ projectId: OTHER_PROJECT, specId: OTHER_SPEC })).toBe(1);
      expect(await model.countPriorUnstrands({ projectId: PROJECT, specId: OTHER_SPEC })).toBe(0);
      expect(await model.countPriorUnstrands({ projectId: OTHER_PROJECT, specId: SPEC })).toBe(0);
    } finally {
      setSystemPool(undefined);
    }
  });
});
