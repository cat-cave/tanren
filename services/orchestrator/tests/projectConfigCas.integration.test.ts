// Real-Postgres proof for ProjectStore.updateConfigIfCurrent — the sole shared
// config write authority for governance/member/budget/brownfield writers.
//
// RoutesPool approximates CAS with JSON.stringify equality and does NOT model
// Postgres JSONB key-order normalization. This file drives the production
// repository SQL against a real DB and proves:
//   (a) successful expected-snapshot update,
//   (b) stale expected snapshot returns no update (conflict),
//   (c) JSON key-order differs in the wire form but matches as JSONB,
//   (d) an interleaved sibling write cannot erase auditPosture (CAS lost-update
//       guard on the durable projects.config row).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a migration-owner DATABASE_URL (same gate
// as the other pg-integration proofs). No new migration.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@tanren/db";
import { ProjectStore } from "../src/engine/repositories/projects.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

function dbName(): string {
  return `tanren_project_config_cas_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_config_cas";
const PROJECT = "proj_config_cas";

const BASE_CONFIG = {
  version: 1,
  auditPosture: {
    blockReviewAt: "P1",
    p2p3Handling: "fix-if-idle",
    autonomousRemediation: false,
  },
} as const;

describeDb("ProjectStore.updateConfigIfCurrent against real Postgres JSONB", () => {
  const database = dbName();
  let ownerPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ($1, 'cas', 'https://example.com/cas.git', $2, $3::jsonb)`,
      [PROJECT, ORG, JSON.stringify(BASE_CONFIG)],
    );
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("updates when the expected snapshot matches the durable row", async () => {
    await resetConfig(ownerPool, BASE_CONFIG);
    const snapshot = await ProjectStore.getConfigSnapshot(ownerPool, PROJECT, systemActor);
    expect(snapshot?.orgId).toBe(ORG);

    const next = {
      ...BASE_CONFIG,
      auditPosture: {
        blockReviewAt: "P3",
        p2p3Handling: "route-to-dag",
        autonomousRemediation: true,
      },
    };
    const ok = await ProjectStore.updateConfigIfCurrent(ownerPool, PROJECT, ORG, snapshot!.config, next, systemActor);
    expect(ok).toBe(true);

    const after = await ProjectStore.getConfig(ownerPool, PROJECT, systemActor);
    expect(after).toMatchObject({
      auditPosture: {
        blockReviewAt: "P3",
        p2p3Handling: "route-to-dag",
        autonomousRemediation: true,
      },
    });
  });

  it("returns no update when the expected snapshot is stale", async () => {
    await resetConfig(ownerPool, BASE_CONFIG);
    const stale = { ...BASE_CONFIG };
    // Sibling write advances the durable snapshot out from under `stale`.
    await ProjectStore.updateConfigIfCurrent(
      ownerPool,
      PROJECT,
      ORG,
      BASE_CONFIG,
      { ...BASE_CONFIG, budget: { ceilingUsd: 10, period: "total" } },
      systemActor,
    );

    const ok = await ProjectStore.updateConfigIfCurrent(
      ownerPool,
      PROJECT,
      ORG,
      stale,
      {
        ...BASE_CONFIG,
        auditPosture: {
          blockReviewAt: "P3",
          p2p3Handling: "route-to-dag",
          autonomousRemediation: true,
        },
      },
      systemActor,
    );
    expect(ok).toBe(false);

    const after = await ProjectStore.getConfig(ownerPool, PROJECT, systemActor);
    // Stale posture write did not land; sibling budget remains.
    expect(after).toMatchObject({ budget: { ceilingUsd: 10, period: "total" } });
    expect(after).toMatchObject({
      auditPosture: {
        blockReviewAt: "P1",
        p2p3Handling: "fix-if-idle",
        autonomousRemediation: false,
      },
    });
  });

  it("matches expected snapshots across JSON key order the way JSONB does", async () => {
    // Wire form key order differs; Postgres JSONB equality is key-order invariant.
    // RoutesPool's JSON.stringify comparison cannot prove this.
    await ownerPool.query(`UPDATE projects SET config = $1::jsonb WHERE project_id = $2`, [
      `{"version":1,"budget":{"period":"total","ceilingUsd":25},"auditPosture":{"blockReviewAt":"P1","p2p3Handling":"fix-if-idle","autonomousRemediation":false}}`,
      PROJECT,
    ]);

    // Expected blob with deliberately different key order than the stored wire form.
    const expectedReordered = {
      auditPosture: {
        autonomousRemediation: false,
        p2p3Handling: "fix-if-idle",
        blockReviewAt: "P1",
      },
      budget: { ceilingUsd: 25, period: "total" },
      version: 1,
    };
    const next = {
      version: 1,
      budget: { ceilingUsd: 25, period: "total" },
      auditPosture: {
        blockReviewAt: "P2",
        p2p3Handling: "route-to-dag",
        autonomousRemediation: false,
      },
    };
    const ok = await ProjectStore.updateConfigIfCurrent(ownerPool, PROJECT, ORG, expectedReordered, next, systemActor);
    expect(ok).toBe(true);

    // Direct SQL proof of the JSONB model the CAS predicate uses.
    const jsonbEq = await ownerPool.query<{ match: boolean }>(
      `SELECT ($1::jsonb IS NOT DISTINCT FROM $2::jsonb) AS match`,
      [`{"b":1,"a":2}`, `{"a":2,"b":1}`],
    );
    expect(jsonbEq.rows[0]?.match).toBe(true);
  });

  it("interleaved sibling config write cannot erase auditPosture", async () => {
    await resetConfig(ownerPool, BASE_CONFIG);
    // Reader A captures the baseline (simulating an admin posture writer).
    const postureSnapshot = await ProjectStore.getConfigSnapshot(ownerPool, PROJECT, systemActor);
    // Sibling budget writer lands first against the same baseline.
    const budgetOk = await ProjectStore.updateConfigIfCurrent(
      ownerPool,
      PROJECT,
      ORG,
      BASE_CONFIG,
      { ...BASE_CONFIG, budget: { ceilingUsd: 99, period: "monthly" } },
      systemActor,
    );
    expect(budgetOk).toBe(true);

    // Stale posture write would have erased budget under LWW; CAS rejects it.
    const postureOk = await ProjectStore.updateConfigIfCurrent(
      ownerPool,
      PROJECT,
      ORG,
      postureSnapshot!.config,
      {
        ...BASE_CONFIG,
        auditPosture: {
          blockReviewAt: "P3",
          p2p3Handling: "route-to-dag",
          autonomousRemediation: true,
        },
      },
      systemActor,
    );
    expect(postureOk).toBe(false);

    const after = await ProjectStore.getConfig(ownerPool, PROJECT, systemActor);
    expect(after).toMatchObject({
      budget: { ceilingUsd: 99, period: "monthly" },
      auditPosture: {
        blockReviewAt: "P1",
        p2p3Handling: "fix-if-idle",
        autonomousRemediation: false,
      },
    });
  });
});

async function resetConfig(pool: Pool, config: unknown): Promise<void> {
  await pool.query(`UPDATE projects SET config = $1::jsonb WHERE project_id = $2`, [JSON.stringify(config), PROJECT]);
}
