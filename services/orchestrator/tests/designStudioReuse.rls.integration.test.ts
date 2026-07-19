// ds-5 — WITHIN-ORG DESIGN REUSE RLS: same-org bind/catalog/export/resolve
// round-trip + cross-org DENIAL. Gated behind TANREN_RLS_DB_TEST=1 + owner
// DATABASE_URL, mirroring designSystemStore.rls.integration.test.ts. Proves a
// project reuses a same-org published design system (release + channel pins) and
// that the bound writer context resolves in the live build path
// (`resolveProjectWebDesignSystem`), while org B / the unscoped runtime pool
// can NEVER bind to, read, or resolve org A's design system — the composite FK
// makes it impossible to reference and RLS (+ FORCE) makes its rows invisible.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { WEB_CATALOG_SCHEMA_VERSION } from "../src/engine/design/system/webCatalog.js";
import { DesignBindingTargetError, DesignStudioStore } from "../src/engine/design/system/designStudioStore.js";
import { resolveProjectWebDesignSystem } from "../src/engine/design/system/designSystemStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_ds5_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_ds5_a";
const ORG_B = "org_ds5_b";
const PROJECT_A = "project_ds5_a";
const PROJECT_B = "project_ds5_b";
const SYSTEM = "system_reuse";
const RELEASE = "release_reuse1";
const ARTIFACT = "artifact_reuse1";
const CONTRACT_DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
const EXPORT_DIGEST = `sha256:${"e".repeat(64)}`;

function writerContext() {
  return {
    designSystemId: SYSTEM,
    releaseId: RELEASE,
    artifactId: ARTIFACT,
    catalog: {
      schemaVersion: WEB_CATALOG_SCHEMA_VERSION,
      framework: "react",
      style: "shadcn",
      components: [
        {
          key: "button",
          primitive: "button",
          packageName: "@org/ui",
          sourcePath: "src/ui/button.tsx",
          tokenBindings: { bg: "color.primary" },
        },
      ],
    },
    tokens: [{ path: "color.primary", cssVariable: "--color-primary", cssValue: "#2563eb" }],
  };
}

describeDb("ds-5 within-org design reuse RLS", () => {
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
       VALUES ($1,'oidc',$1,$1,$1,'{"version":1}'::jsonb),($2,'oidc',$2,$2,$2,'{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1,$1,'https://example.com/a.git','main','runner:v0',$2,'{"version":1}'::jsonb),
              ($3,$3,'https://example.com/b.git','main','runner:v0',$4,'{"version":1}'::jsonb)`,
      [PROJECT_A, ORG_A, PROJECT_B, ORG_B],
    );

    // Org A: a published, reusable web design system with a canonical artifact
    // carrying a valid Writer projection + an export file + a stable channel.
    await runWithOrgScope(ownerPool, ORG_A, async (client) => {
      await client.query(
        `INSERT INTO design_systems (org_id, id, slug, name, description, lifecycle, default_channel)
         VALUES ($1,$2,'console','Console DS','reusable','active','stable')`,
        [ORG_A, SYSTEM],
      );
      await client.query(
        `INSERT INTO design_artifacts
           (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size, web_writer_context)
         VALUES ($1,$2,$3,$4,'application/vnd.tanren.design.manifest+json',1,$5,256,$6::jsonb)`,
        [
          ORG_A,
          ARTIFACT,
          SYSTEM,
          ARTIFACT_DIGEST,
          `sha256/${ARTIFACT_DIGEST.slice(7, 9)}/${ARTIFACT_DIGEST.slice(7)}`,
          JSON.stringify(writerContext()),
        ],
      );
      await client.query(
        `INSERT INTO design_artifact_files (org_id, artifact_id, path, kind, media_type, digest, byte_size, executable)
         VALUES ($1,$2,'exports/tokens.css','export','text/css',$3,42,false)`,
        [ORG_A, ARTIFACT, EXPORT_DIGEST],
      );
      await client.query(
        `INSERT INTO design_system_releases
           (org_id, id, design_system_id, version, state, contract_id, contract_version, contract_digest,
            manifest_schema_version, canonical_artifact_id, created_by, published_by, published_at)
         VALUES ($1,$2,$3,1,'published','contract_a',1,$4,1,$5,'seed','operator',now())`,
        [ORG_A, RELEASE, SYSTEM, CONTRACT_DIGEST, ARTIFACT],
      );
      await client.query(
        `INSERT INTO design_release_channels (org_id, design_system_id, channel, release_id)
         VALUES ($1,$2,'stable',$3)`,
        [ORG_A, SYSTEM, RELEASE],
      );
    });
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

  it("POSITIVE — a project reuses a same-org system (release pin) and the bound context resolves live", async () => {
    const store = new DesignStudioStore(runtimePool);
    const binding = await store.putBinding({
      orgId: ORG_A,
      projectId: PROJECT_A,
      designSystemId: SYSTEM,
      pinMode: "release",
      pinnedReleaseId: RELEASE,
      boundBy: "operator_a",
    });
    expect(binding.pinnedReleaseId).toBe(RELEASE);

    const read = await store.getBinding(ORG_A, PROJECT_A);
    expect(read?.designSystemId).toBe(SYSTEM);

    const catalog = await store.listCatalog(ORG_A);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.reuseCount).toBe(1);
    expect(catalog[0]?.latestPublishedRelease?.releaseId).toBe(RELEASE);

    const exports = await store.listExportFiles(ORG_A, ARTIFACT);
    expect(exports.map((f) => f.path)).toEqual(["exports/tokens.css"]);

    // The reuse is LOAD-BEARING: the writer/land-gate path resolves the bound system.
    const resolved = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_A, projectId: PROJECT_A }),
    );
    expect(resolved?.designSystemId).toBe(SYSTEM);
    expect(resolved?.releaseId).toBe(RELEASE);
  });

  it("POSITIVE — a channel pin resolves the channel's published release", async () => {
    const store = new DesignStudioStore(runtimePool);
    await store.putBinding({
      orgId: ORG_A,
      projectId: PROJECT_A,
      designSystemId: SYSTEM,
      pinMode: "channel",
      channel: "stable",
      boundBy: "operator_a",
    });
    const resolved = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_A, projectId: PROJECT_A }),
    );
    expect(resolved?.releaseId).toBe(RELEASE);
  });

  it("NEGATIVE — a non-published / unknown target fails LOUD, never a fabricated bind", async () => {
    const store = new DesignStudioStore(runtimePool);
    await expect(
      store.putBinding({
        orgId: ORG_A,
        projectId: PROJECT_A,
        designSystemId: SYSTEM,
        pinMode: "release",
        pinnedReleaseId: "release_does_not_exist",
        boundBy: "operator_a",
      }),
    ).rejects.toBeInstanceOf(DesignBindingTargetError);
  });

  it("NEGATIVE CONTROL — org B can NEVER reuse, read, or resolve org A's design system", async () => {
    const store = new DesignStudioStore(runtimePool);

    // Org B cannot bind project B to org A's system — RLS hides the system row.
    await expect(
      store.putBinding({
        orgId: ORG_B,
        projectId: PROJECT_B,
        designSystemId: SYSTEM,
        pinMode: "release",
        pinnedReleaseId: RELEASE,
        boundBy: "attacker",
      }),
    ).rejects.toBeInstanceOf(DesignBindingTargetError);

    // Org B sees ZERO of org A's catalog, bindings, and exports.
    expect(await store.listCatalog(ORG_B)).toHaveLength(0);
    expect(await store.getBinding(ORG_B, PROJECT_A)).toBeNull();
    expect(await store.listExportFiles(ORG_B, ARTIFACT)).toHaveLength(0);

    // Org B cannot resolve org A's bound writer context.
    const resolvedB = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      resolveProjectWebDesignSystem(client, { orgId: ORG_B, projectId: PROJECT_A }),
    );
    expect(resolvedB).toBeUndefined();

    // Scoped org B raw SELECT + the unscoped runtime pool (no GUC) see zero rows.
    const scopedB = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT project_id FROM project_design_bindings"),
    );
    expect(scopedB.rowCount).toBe(0);
    const unscoped = await runtimePool.query("SELECT project_id FROM project_design_bindings");
    expect(unscoped.rowCount).toBe(0);
  });
});
