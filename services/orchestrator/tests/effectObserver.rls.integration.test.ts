// Real-Postgres proof for rv-8's immutable observer evidence and mutable
// watermarks. This suite runs only from the RLS smoke recipe.

import { migrate, runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgSideEffectObserverAdapter } from "../src/engine/verification/effectObserver/pgSideEffectObserverAdapter.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_effect_observer_a";
const ORG_B = "org_effect_observer_b";
const PROJECT_A = "project_effect_observer_a";
const PROJECT_B = "project_effect_observer_b";
const TRIGGER_A = `sha256:${"a".repeat(64)}`;

function databaseName(): string {
  return `tanren_effect_observer_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(url: string, database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedTenant(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.test/effects.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
    [projectId, orgId],
  );
}

describeDb("SideEffectObserverAdapter — immutable evidence, watermark upsert, and RLS", () => {
  const database = databaseName();
  let ownerPool: Pool;
  let appPool: Pool;
  let observer: PgSideEffectObserverAdapter;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: connectionUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({
      connectionString: connectionUrl(ADMIN_URL, database, { user: APP_ROLE, password: APP_PASSWORD }),
    });
    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);
    observer = new PgSideEffectObserverAdapter(appPool);
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("observes ok/missing/duplicate, advances watermarks, and rejects evidence mutation", async () => {
    const ok = await observer.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      triggerIdHash: TRIGGER_A,
      afterWatermark: "cursor_1",
    });
    const duplicate = await observer.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      triggerIdHash: TRIGGER_A,
      afterWatermark: "cursor_1",
    });
    const missing = await observer.observe({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      provider: "github",
      afterWatermark: "cursor_2",
    });
    await observer.advanceWatermark({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      watermark: "cursor_2",
    });
    await observer.advanceWatermark({
      orgId: ORG_A,
      projectId: PROJECT_A,
      observer: "github_webhook",
      watermark: "cursor_3",
    });

    expect([ok[0]?.classification, duplicate[0]?.classification, missing[0]?.classification]).toEqual([
      "ok",
      "duplicate",
      "missing",
    ]);
    expect(duplicate[0]?.occurrenceCount).toBe(2);

    const own = await runWithOrgScope(appPool, ORG_A, async (client) => {
      const observations = await client.query<{ classification: string; occurrence_count: number }>(
        `SELECT classification, occurrence_count
           FROM behavior_effect_observations
          WHERE org_id = $1 AND project_id = $2
          ORDER BY created_at, observation_id`,
        [ORG_A, PROJECT_A],
      );
      const watermarks = await client.query<{ watermark: string }>(
        `SELECT watermark
           FROM effect_observer_watermarks
          WHERE org_id = $1 AND project_id = $2 AND observer = $3`,
        [ORG_A, PROJECT_A, "github_webhook"],
      );
      const events = await client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type = ANY($3::text[])
          ORDER BY id`,
        [
          ORG_A,
          PROJECT_A,
          [
            "behavior.effect.observed",
            "behavior.effect.duplicate",
            "behavior.effect.missing",
            "observer.inconclusive_external",
            "observer.watermark.advanced",
          ],
        ],
      );
      return {
        observations: observations.rows,
        watermarks: watermarks.rows,
        eventTypes: events.rows.map((row) => row.event_type),
      };
    });
    expect(own.observations).toHaveLength(3);
    expect(own.observations).toEqual(
      expect.arrayContaining([
        { classification: "ok", occurrence_count: 1 },
        { classification: "duplicate", occurrence_count: 2 },
        { classification: "missing", occurrence_count: 0 },
      ]),
    );
    expect(own.watermarks).toEqual([{ watermark: "cursor_3" }]);
    expect(own.eventTypes).toEqual([
      "behavior.effect.observed",
      "behavior.effect.duplicate",
      "behavior.effect.missing",
      "observer.inconclusive_external",
      "observer.watermark.advanced",
      "observer.watermark.advanced",
    ]);

    const observationId = ok[0]?.observationId;
    expect(observationId).toBeDefined();
    await expect(
      runWithOrgScope(appPool, ORG_A, (client) =>
        client.query(
          "UPDATE behavior_effect_observations SET observer = 'changed' WHERE org_id = $1 AND observation_id = $2",
          [ORG_A, observationId],
        ),
      ),
    ).rejects.toThrow(/immutable.*append-only.*UPDATE rejected/iu);
    await expect(
      runWithOrgScope(appPool, ORG_A, (client) =>
        client.query("DELETE FROM behavior_effect_observations WHERE org_id = $1 AND observation_id = $2", [
          ORG_A,
          observationId,
        ]),
      ),
    ).rejects.toThrow(/immutable.*append-only.*DELETE rejected/iu);
  });

  it("returns zero observer evidence and watermarks from the foreign org", async () => {
    const foreign = await runWithOrgScope(appPool, ORG_B, async (client) => {
      const observations = await client.query(
        "SELECT observation_id FROM behavior_effect_observations WHERE org_id = $1 AND project_id = $2",
        [ORG_A, PROJECT_A],
      );
      const watermarks = await client.query(
        "SELECT observer FROM effect_observer_watermarks WHERE org_id = $1 AND project_id = $2",
        [ORG_A, PROJECT_A],
      );
      return { observations: observations.rowCount, watermarks: watermarks.rowCount };
    });
    expect(foreign).toEqual({ observations: 0, watermarks: 0 });
  });
});
