// Real-Postgres proofs for config_revision CAS + RLS (ephemeral DB):
//   - fresh 0000→0041 migrate and initial revision 1
//   - explicit 0040→0041 upgrade-only drill
//   - concurrent same-revision writers: one winner, one conflict
//   - mutateProjectConfig field interleaving
//   - same-org success; cross-org denial / zero effects; missing≡foreign
//   - org concurrent CAS + org cross-org mirror
//   - no-op cannot stale-succeed; key-order JSONB is no-op
//   - non-config update does not bump revision
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL.

import { migrate, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mutateProjectConfig } from "../src/engine/config/projectConfigMutate.js";
import { OrganizationsStore } from "../src/engine/repositories/organizations.js";
import { ProjectStore } from "../src/engine/repositories/projects.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeIf = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = `org_cas_a_${randomUUID().slice(0, 8)}`;
const ORG_B = `org_cas_b_${randomUUID().slice(0, 8)}`;
const PROJECT_A = `proj_cas_a_${randomUUID().slice(0, 8)}`;

function dbName(): string {
  return `tanren_cas_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describeIf("config revision CAS (real Postgres + RLS)", () => {
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

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'github_org', $1, $1, $1, '{"version":1}'::jsonb),
              ($2, 'github_org', $2, $2, $2, '{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'CAS A', 'https://github.com/example/cas-a', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [PROJECT_A, ORG_A],
    );
  }, 120_000);

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
  });

  it("initial config_revision is 1 for project and organization rows", async () => {
    const proj = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, PROJECT_A, systemActor),
    );
    expect(proj?.revision).toBe("1");
    const org = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      OrganizationsStore.getConfigSnapshot(client, ORG_A, systemActor),
    );
    expect(org?.revision).toBe("1");
  });

  it("two concurrent same-revision CAS writers: one winner, one conflict", async () => {
    const projectId = `proj_race_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'race', 'https://github.com/example/race', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [projectId, ORG_A],
    );

    const results = await Promise.all(
      (["winner", "loser"] as const).map((tag) =>
        runWithOrgScope(runtimePool, ORG_A, (client) =>
          ProjectStore.compareAndSwapConfig(client, projectId, "1", { version: 1, tag }, systemActor),
        ),
      ),
    );
    const oks = results.filter((r) => r.status === "ok");
    const conflicts = results.filter((r) => r.status === "conflict");
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(oks[0]).toMatchObject({ status: "ok", revision: "2" });
    const final = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId, systemActor),
    );
    expect(final?.revision).toBe("2");
    // Winner's JSONB is the durable state (either concurrent tag may win).
    expect(final?.config).toMatchObject({ version: 1, tag: expect.stringMatching(/^(winner|loser)$/u) });
    expect(oks.map((r) => (r.status === "ok" ? r.config : null))).toContainEqual(final?.config);
  });

  it("mutateProjectConfig interleaving preserves independent field changes", async () => {
    const projectId = `proj_mut_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'mut', 'https://github.com/example/mut', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [projectId, ORG_A],
    );

    await Promise.all([
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        mutateProjectConfig(client, projectId, systemActor, (raw) => {
          const cur = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
          return { ...cur, version: 1, budget: { ceilingUsd: 25, period: "total" } };
        }),
      ),
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        mutateProjectConfig(client, projectId, systemActor, (raw) => {
          const cur = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
          return { ...cur, version: 1, auditPosture: { mode: "strict" } };
        }),
      ),
    ]);

    const final = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId, systemActor),
    );
    expect(final?.config).toMatchObject({
      budget: { ceilingUsd: 25, period: "total" },
      auditPosture: { mode: "strict" },
    });
    expect(Number(final?.revision)).toBeGreaterThanOrEqual(2);
  });

  it("same-org success; cross-org denial is indistinguishable from absence (zero effects)", async () => {
    const snapA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, PROJECT_A, systemActor),
    );
    expect(snapA).toBeDefined();

    const crossSnap = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      ProjectStore.getConfigSnapshot(client, PROJECT_A, systemActor),
    );
    expect(crossSnap).toBeUndefined();

    const crossCas = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      ProjectStore.compareAndSwapConfig(client, PROJECT_A, "1", { version: 1, poisoned: true }, systemActor),
    );
    expect(crossCas.status).toBe("not_found");

    const after = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, PROJECT_A, systemActor),
    );
    expect(after?.config).not.toMatchObject({ poisoned: true });
  });

  it("non-config lifecycle update does not bump config_revision", async () => {
    const projectId = `proj_lc_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'lc', 'https://github.com/example/lc', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [projectId, ORG_A],
    );
    const before = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId, systemActor),
    );
    expect(before?.revision).toBe("1");
    await runWithSystemScope(ownerPool, async (client) => {
      await client.query(`UPDATE projects SET lifecycle = 'archived' WHERE project_id = $1`, [projectId]);
    });
    const after = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId, systemActor),
    );
    expect(after?.revision).toBe("1");
  });

  it("semantic no-op keeps revision unchanged; key-order-equivalent JSONB is a no-op", async () => {
    const projectId = `proj_noop_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'noop', 'https://github.com/example/noop', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"a":1,"b":2,"version":1}'::jsonb, $2)`,
      [projectId, ORG_A],
    );
    const equal = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.compareAndSwapConfig(client, projectId, "1", { a: 1, b: 2, version: 1 }, systemActor),
    );
    expect(equal).toMatchObject({ status: "ok", revision: "1" });
    // Key order differs from stored JSON text but JSONB-equal ⇒ no bump.
    const reordered = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.compareAndSwapConfig(client, projectId, "1", { b: 2, a: 1, version: 1 }, systemActor),
    );
    expect(reordered).toMatchObject({ status: "ok", revision: "1" });
    const final = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId, systemActor),
    );
    expect(final?.revision).toBe("1");
  });

  it("no-op cannot stale-succeed after a competing project writer commits", async () => {
    const projectId = `proj_noop_race_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'noop-race', 'https://github.com/example/noop-race', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [projectId, ORG_A],
    );
    const initial = { version: 1 };
    // Competing writer commits first — the classic window the unlocked short-circuit lost.
    const winner = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.compareAndSwapConfig(client, projectId, "1", { version: 1, tag: "writer" }, systemActor),
    );
    expect(winner).toMatchObject({ status: "ok", revision: "2" });
    // Stale no-op at expected revision 1 with the pre-race config must conflict, not ok@1.
    const staleNoop = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.compareAndSwapConfig(client, projectId, "1", initial, systemActor),
    );
    expect(staleNoop).toMatchObject({
      status: "conflict",
      current: { revision: "2", config: { tag: "writer" } },
    });
    // Concurrent no-op vs writer: outcomes must be consistent with a single serial order.
    const projectId2 = `proj_noop_race2_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ($1, 'noop-race2', 'https://github.com/example/noop-race2', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, $2)`,
      [projectId2, ORG_A],
    );
    const concurrent = await Promise.all([
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        ProjectStore.compareAndSwapConfig(client, projectId2, "1", { version: 1 }, systemActor),
      ),
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        ProjectStore.compareAndSwapConfig(client, projectId2, "1", { version: 1, tag: "w" }, systemActor),
      ),
    ]);
    const durable = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ProjectStore.getConfigSnapshot(client, projectId2, systemActor),
    );
    const oks = concurrent.filter((r) => r.status === "ok");
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.every((o) => Number(o.revision) <= Number(durable?.revision))).toBe(true);
    const headOks = oks.filter((o) => o.revision === durable?.revision);
    expect(headOks.every((o) => JSON.stringify(o.config) === JSON.stringify(durable?.config))).toBe(true);
  });

  it("org concurrent same-revision CAS: one winner, one conflict", async () => {
    const orgId = `org_race_${randomUUID().slice(0, 8)}`;
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'github_org', $1, $1, $1, '{"version":1}'::jsonb)`,
      [orgId],
    );
    const results = await Promise.all(
      (["winner", "loser"] as const).map((tag) =>
        runWithOrgScope(runtimePool, orgId, (client) =>
          OrganizationsStore.compareAndSwapConfig(client, orgId, "1", { version: 1, tag }, systemActor),
        ),
      ),
    );
    const oks = results.filter((r) => r.status === "ok");
    const conflicts = results.filter((r) => r.status === "conflict");
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(oks[0]).toMatchObject({ status: "ok", revision: "2" });
    const final = await runWithOrgScope(runtimePool, orgId, (client) =>
      OrganizationsStore.getConfigSnapshot(client, orgId, systemActor),
    );
    expect(final?.revision).toBe("2");
    expect(final?.config).toMatchObject({ version: 1, tag: expect.stringMatching(/^(winner|loser)$/u) });
  });

  it("org cross-org CAS denial is indistinguishable from absence (zero effects)", async () => {
    const snapA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      OrganizationsStore.getConfigSnapshot(client, ORG_A, systemActor),
    );
    expect(snapA).toBeDefined();
    const crossSnap = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      OrganizationsStore.getConfigSnapshot(client, ORG_A, systemActor),
    );
    expect(crossSnap).toBeUndefined();
    const crossCas = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      OrganizationsStore.compareAndSwapConfig(client, ORG_A, "1", { version: 1, poisoned: true }, systemActor),
    );
    expect(crossCas.status).toBe("not_found");
    const after = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      OrganizationsStore.getConfigSnapshot(client, ORG_A, systemActor),
    );
    expect(after?.config).not.toMatchObject({ poisoned: true });
  });
});

describeIf("config_revision migration 0040→0041 upgrade", () => {
  const database = dbName();
  let ownerPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    // Fresh chain through 0040-equivalent populated schema: migrate all, then
    // strip 0041 columns so re-applying 0041 SQL is an explicit upgrade drill.
    await migrate(ownerPool);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ('org_upgrade', 'github_org', 'org_upgrade', 'org_upgrade', 'org_upgrade', '{"version":1}'::jsonb)`,
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, config, org_id)
       VALUES ('proj_upgrade', 'upgrade', 'https://github.com/example/upgrade', 'main',
               'ghcr.io/example/runner:v0', 'local-docker', '{"version":1}'::jsonb, 'org_upgrade')`,
    );
    await ownerPool.query(`ALTER TABLE projects DROP COLUMN config_revision`);
    await ownerPool.query(`ALTER TABLE organizations DROP COLUMN config_revision`);
  }, 120_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  });

  it("0041 ADD COLUMN DEFAULT 1 backfills existing rows and defaults new inserts", async () => {
    const before = await ownerPool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'config_revision'`,
    );
    expect(before.rowCount).toBe(0);

    // tests/ → orchestrator/ → services/ → worktree root
    const migrationsDir = join(import.meta.dirname, "../../../db/migrations");
    const sql0041 = readFileSync(join(migrationsDir, "0041_config_revision.sql"), "utf8");
    // Drizzle statement breakpoints are line comments after `;` — apply as one script.
    await ownerPool.query(sql0041);

    const projRev = await ownerPool.query<{ config_revision: string }>(
      `SELECT config_revision::text AS config_revision FROM projects WHERE project_id = 'proj_upgrade'`,
    );
    const orgRev = await ownerPool.query<{ config_revision: string }>(
      `SELECT config_revision::text AS config_revision FROM organizations WHERE id = 'org_upgrade'`,
    );
    expect(projRev.rows[0]?.config_revision).toBe("1");
    expect(orgRev.rows[0]?.config_revision).toBe("1");

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ('org_new', 'github_org', 'org_new', 'org_new', 'org_new', '{"version":1}'::jsonb)`,
    );
    const newOrg = await ownerPool.query<{ config_revision: string }>(
      `SELECT config_revision::text AS config_revision FROM organizations WHERE id = 'org_new'`,
    );
    expect(newOrg.rows[0]?.config_revision).toBe("1");
  });
});
