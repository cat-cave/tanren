// ds-3 (F2D) — DesignFragmentStore RLS: same-org round-trip + retract + cross-org
// denial. Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL, mirroring
// designSystemStore.rls.integration.test.ts. Proves a validated design fragment
// persists org-scoped, retracts (deleteById) under scope, and that org B / the
// unscoped runtime pool see ZERO of org A's rows (deny-by-default RLS + FORCE), as
// the non-superuser `tanren_app` role.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { parseDesignFragmentSpec } from "../src/engine/design/system/designArtifactSchemas.js";
import { sha256Digest } from "../src/engine/design/system/artifactStore.js";
import {
  canonicalDesignFragmentDraftJson,
  designFragmentDraftDigest,
  designFragmentReleaseId,
  DesignFragmentStore,
  type DesignFragmentDraftV1,
  type ValidatedDesignFragment,
} from "../src/engine/design/system/authoring/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_ds3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_ds3_a";
const ORG_B = "org_ds3_b";

function validatedFragment(orgId: string, kind: string, label: string): ValidatedDesignFragment {
  const draft: DesignFragmentDraftV1 = {
    kind,
    label,
    phase: "patterns-and-templates",
    version: "1.0.0",
    targetCapabilities: ["shadcn"],
    requires: [],
    provides: [],
    dependsOn: [],
    conflicts: [],
    replaces: [],
    personaRefs: [],
    behaviorRefs: [],
    conformanceSuiteId: `${kind}.conformance.v1`,
    operations: [
      {
        operation: "addComponent",
        path: `components/${label}.tsx`,
        fileKind: "component-source",
        mediaType: "text/plain",
        content: "export const C = () => null;",
        executable: false,
      },
    ],
  };
  const bytes = new TextEncoder().encode(draft.operations[0]!.content);
  return {
    fragmentReleaseId: designFragmentReleaseId(orgId, kind, label, "1.0.0"),
    fragmentDigest: designFragmentDraftDigest(draft),
    fragmentVersion: "1.0.0",
    spec: parseDesignFragmentSpec({
      kind,
      label,
      phase: "patterns-and-templates",
      version: "1.0.0",
      conformanceSuiteId: `${kind}.conformance.v1`,
    }),
    files: [
      {
        path: `components/${label}.tsx`,
        kind: "component-source",
        mediaType: "text/plain",
        digest: sha256Digest(bytes),
        byteSize: bytes.byteLength,
        executable: false,
      },
    ],
    canonicalBody: canonicalDesignFragmentDraftJson(draft),
    draft,
  };
}

describeDb("DesignFragmentStore RLS (ds-3 F2D registry)", () => {
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
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb),
              ($2, 'oidc', $2, $2, $2, '{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
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

  it("runs as the non-superuser tanren_app role (no rolsuper / rolbypassrls)", async () => {
    const identity = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("POSITIVE — a validated fragment persists org-scoped, round-trips, and retracts", async () => {
    const store = new DesignFragmentStore(runtimePool);
    const { persistedId } = await store.createValidated({
      orgId: ORG_A,
      createdBy: "actor_a",
      fragment: validatedFragment(ORG_A, "surface/dashboard", "Dashboard"),
    });
    expect(persistedId).toBe("org_ds3_a:surface/dashboard-Dashboard:1.0.0");

    const got = await store.get(ORG_A, persistedId);
    expect(got?.status).toBe("validated");
    expect(got?.kind).toBe("surface/dashboard");
    expect((await store.listPresentByOrg(ORG_A)).map((k) => k.kind)).toEqual(["surface/dashboard"]);

    // Retract-with-delete under scope removes the row.
    await store.deleteById(ORG_A, persistedId);
    expect(await store.get(ORG_A, persistedId)).toBeUndefined();
    expect(await store.listPresentByOrg(ORG_A)).toEqual([]);
  });

  it("NEGATIVE CONTROL — org B and the unscoped runtime pool see ZERO of org A's rows", async () => {
    const store = new DesignFragmentStore(runtimePool);
    await store.createValidated({
      orgId: ORG_A,
      createdBy: "actor_a",
      fragment: validatedFragment(ORG_A, "surface/settings", "Settings"),
    });

    // Cross-org read via the store sees nothing.
    expect(await store.get(ORG_B, "org_ds3_a:surface/settings-Settings:1.0.0")).toBeUndefined();
    expect(await store.listPresentByOrg(ORG_B)).toEqual([]);

    // Scoped org B raw SELECT sees zero rows.
    const crossRows = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT id FROM design_fragments"),
    );
    expect(crossRows.rowCount).toBe(0);

    // Unscoped runtime pool (no app.current_org_id GUC) sees zero rows — FORCE RLS.
    const denied = await runtimePool.query("SELECT id FROM design_fragments");
    expect(denied.rowCount).toBe(0);
  });
});
