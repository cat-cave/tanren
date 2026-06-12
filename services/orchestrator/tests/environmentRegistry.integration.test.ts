// Environment management (environment-management.md §7 P3) — the `environments`
// registry store DAL, proven against a REAL Postgres (no SQL mocks), mirroring the
// `templateRegistry.integration.test.ts` cohort. Proves end-to-end:
//   (a) EnvironmentStore.create/get/getByEnvKey round-trip under an org scope,
//       decoded to the contract shape (capabilities/provenance re-parsed);
//   (b) getByEnvKey resolves a VALIDATED/OFFICIAL match + skips a DRAFT; a re-create
//       of the same (org, env_key) UPSERTs (no duplicate);
//   (c) listByCapabilities filters on the `capabilities.tools` jsonb;
//   (d) ORG SCOPE under RLS: org A sees its own envs PLUS the cross-org `official`
//       catalogue, but NEVER org B's PRIVATE envs; an UNSCOPED runtime-pool read
//       sees ZERO private rows (only official) — the deny-by-default behavior;
//   (e) WRITES stay org-scoped: org A cannot INSERT a row owned by org B (the WITH
//       CHECK with no official escape hatch rejects it).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the templates/R1/R2 cohort tests. Wired into `just smoke`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { EnvironmentStore, type RegisterEnvironmentInput } from "../src/engine/repositories/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_env_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_env_a";
const ORG_B = "org_env_b";
const ORG_PLATFORM = "org_env_platform";
const ACTOR = { kind: "operator" as const };

// A registration builder — varies the env_key + tools so the lookups + capability
// query have something to filter on.
function reg(opts: {
  org: string;
  envKey: string;
  imageRef: string;
  tools: Record<string, string>;
  status?: "draft" | "validated" | "official";
}): RegisterEnvironmentInput {
  return {
    orgId: opts.org,
    envKey: opts.envKey,
    imageRef: opts.imageRef,
    capabilities: { tools: opts.tools },
    provenance: { baseDigest: "golden-deadbeef", miseLockHash: "lock-hash" },
    ...(opts.status !== undefined && { status: opts.status }),
  };
}

describeDb("environments registry DAL — org scope + official cross-org tier", () => {
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

    for (const org of [ORG_A, ORG_B, ORG_PLATFORM]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
    }
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

  it("(a) create/get/getByEnvKey round-trip under an org scope", async () => {
    const created = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.create(
        client,
        reg({
          org: ORG_A,
          envKey: "key_node22",
          imageRef: "reg/env@sha256:n22",
          tools: { node: "22" },
          status: "validated",
        }),
        ACTOR,
      ),
    );
    expect(created.orgId).toBe(ORG_A);
    expect(created.status).toBe("validated");
    expect(created.channel).toBe("lts");
    expect(created.capabilities.tools["node"]).toBe("22");
    expect(created.provenance.baseDigest).toBe("golden-deadbeef");
    expect(created.validationProof).toBeNull();

    const got = await runWithOrgScope(runtimePool, ORG_A, (client) => EnvironmentStore.get(client, created.id, ACTOR));
    expect(got).toEqual(created);

    // The content-key resolution lookup matches a validated env.
    const byKey = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.getByEnvKey(client, "key_node22", ["validated", "official"], ACTOR),
    );
    expect(byKey?.id).toBe(created.id);
    expect(byKey?.imageRef).toBe("reg/env@sha256:n22");
  });

  it("(b) getByEnvKey skips a DRAFT; re-create of (org, env_key) UPSERTs", async () => {
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.create(
        client,
        reg({ org: ORG_A, envKey: "key_draft", imageRef: "reg/env@sha256:draft", tools: { python: "3.13" } }),
        ACTOR,
      ),
    );
    // A draft env is NOT resolved when the filter restricts to validated/official.
    const skipped = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.getByEnvKey(client, "key_draft", ["validated", "official"], ACTOR),
    );
    expect(skipped).toBeUndefined();

    // Re-register the SAME (org, env_key) — UPSERT updates image_ref + status, no duplicate.
    const upserted = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.create(
        client,
        reg({
          org: ORG_A,
          envKey: "key_draft",
          imageRef: "reg/env@sha256:rebuilt",
          tools: { python: "3.13" },
          status: "validated",
        }),
        ACTOR,
      ),
    );
    expect(upserted.imageRef).toBe("reg/env@sha256:rebuilt");
    expect(upserted.status).toBe("validated");

    const count = await runWithSystemScope(ownerPool, (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM environments WHERE env_key = 'key_draft'"),
    );
    expect(count.rows[0]?.count).toBe("1");

    // Now it resolves (validated).
    const resolved = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.getByEnvKey(client, "key_draft", ["validated", "official"], ACTOR),
    );
    expect(resolved?.imageRef).toBe("reg/env@sha256:rebuilt");
  });

  it("(c) listByCapabilities filters on the capabilities.tools jsonb", async () => {
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.create(
        client,
        reg({
          org: ORG_A,
          envKey: "key_go",
          imageRef: "reg/env@sha256:go",
          tools: { go: "1.23" },
          status: "validated",
        }),
        ACTOR,
      ),
    );
    // The tool KEY exists (any version).
    const go = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.listByCapabilities(client, { tool: "go" }, ACTOR),
    );
    expect(go.map((e) => e.envKey)).toContain("key_go");
    expect(go.every((e) => "go" in e.capabilities.tools)).toBe(true);

    // Exact tool@version match.
    const go123 = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.listByCapabilities(client, { tool: "go", version: "1.23" }, ACTOR),
    );
    expect(go123.map((e) => e.envKey)).toContain("key_go");
    const goWrong = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.listByCapabilities(client, { tool: "go", version: "9.99" }, ACTOR),
    );
    expect(goWrong.map((e) => e.envKey)).not.toContain("key_go");
  });

  it("(d) org A sees its own + official, never org B's private; unscoped sees only official", async () => {
    await runWithOrgScope(runtimePool, ORG_B, (client) =>
      EnvironmentStore.create(
        client,
        reg({
          org: ORG_B,
          envKey: "key_b_secret",
          imageRef: "reg/env@sha256:b-secret",
          tools: { node: "20" },
          status: "validated",
        }),
        ACTOR,
      ),
    );
    const official = await runWithOrgScope(runtimePool, ORG_PLATFORM, (client) =>
      EnvironmentStore.create(
        client,
        reg({
          org: ORG_PLATFORM,
          envKey: "key_official",
          imageRef: "reg/env@sha256:official",
          tools: { node: "22" },
          status: "official",
        }),
        ACTOR,
      ),
    );

    // Org A's scoped list: its OWN envs + the official one, but NOT org B's private.
    const listA = await runWithOrgScope(runtimePool, ORG_A, (client) => EnvironmentStore.list(client, ACTOR));
    const orgsSeen = new Set(listA.map((e) => e.orgId));
    expect(orgsSeen.has(ORG_A)).toBe(true);
    expect(orgsSeen.has(ORG_PLATFORM)).toBe(true);
    expect(orgsSeen.has(ORG_B)).toBe(false);

    // Org A resolves the official env by key (cross-org read of the shared tier).
    const officialFromA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.getByEnvKey(client, "key_official", ["validated", "official"], ACTOR),
    );
    expect(officialFromA?.id).toBe(official.id);

    // Org A CANNOT resolve org B's private env, even by its exact key.
    const bFromA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      EnvironmentStore.getByEnvKey(client, "key_b_secret", ["validated", "official"], ACTOR),
    );
    expect(bFromA).toBeUndefined();

    // An UNSCOPED runtime-pool read (empty GUC) sees ONLY official rows.
    const unscoped = await EnvironmentStore.list(runtimePool, ACTOR);
    expect(unscoped.every((e) => e.status === "official")).toBe(true);
    expect(unscoped.some((e) => e.id === official.id)).toBe(true);
  });

  it("(e) a write cannot land under a different org (WITH CHECK rejects)", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        EnvironmentStore.create(
          client,
          reg({ org: ORG_B, envKey: "spoof", imageRef: "reg/env@sha256:spoof", tools: { node: "22" } }),
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/row-level security/u);

    const owned = await runWithSystemScope(ownerPool, (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM environments WHERE env_key = 'spoof'"),
    );
    expect(owned.rows[0]?.count).toBe("0");
  });
});
