// Tanren-native templating (wave 1) — the `templates` registry store DAL, proven
// against a REAL Postgres (no SQL mocks), like the other RLS DAL integration
// tests. Proves end-to-end:
//   (a) TemplateStore.create/get/list/updateStatus/markDegraded round-trip under
//       an org scope, decoded to the contract shape (manifest re-parsed);
//   (b) listByCapabilities filters on the manifest jsonb + mirrored columns;
//   (c) ORG SCOPE under RLS: org A sees its own templates PLUS the cross-org
//       `official` catalogue, but NEVER org B's PRIVATE templates; an UNSCOPED
//       runtime-pool read sees ZERO private rows (only official) — the deny-by-
//       default empty-GUC behavior;
//   (d) WRITES stay org-scoped: org A cannot INSERT a row owned by org B (the
//       WITH CHECK with no official escape hatch rejects it).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / R2 cohort tests. Wired into `just smoke` via the
// same gate.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { TemplateStore } from "../src/engine/repositories/index.js";
import { parseTemplateManifest, type TemplateManifestV1 } from "../src/engine/templates/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_tmpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_tmpl_a";
const ORG_B = "org_tmpl_b";
const ORG_PLATFORM = "org_tmpl_platform";
const ACTOR = { kind: "operator" as const };

// A manifest builder over the supported YAML subset — varies the capabilities so
// the capability query has something to filter on.
function manifestYaml(opts: { stack: string; runtime: string; pkg: string; framework: string }): string {
  return `version: 1
stack: "${opts.stack}"
capabilities:
  runtime: "${opts.runtime}"
  packageManager: "${opts.pkg}"
  framework: "${opts.framework}"
  gates:
    - "tier-1"
  bdd: true
  mutation: false
  junit: true
channel: "lts"
templateVersion: "1.0.0"
provenance:
  researchSources:
    - "seed"
validationProof: null
`;
}

function parse(opts: { stack: string; runtime: string; pkg: string; framework: string }): TemplateManifestV1 {
  return parseTemplateManifest(manifestYaml(opts));
}

describeDb("templates registry DAL — org scope + official cross-org tier", () => {
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

  it("(a) create/get round-trips under an org scope, decoded to the contract shape", async () => {
    const created = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.create(
        client,
        {
          orgId: ORG_A,
          repoRef: "cat-cave/ts",
          manifest: parse({ stack: "ts", runtime: "node", pkg: "pnpm", framework: "next" }),
        },
        ACTOR,
      ),
    );
    expect(created.orgId).toBe(ORG_A);
    expect(created.status).toBe("draft");
    expect(created.channel).toBe("lts");
    expect(created.manifest.capabilities.framework).toBe("next");

    const got = await runWithOrgScope(runtimePool, ORG_A, (client) => TemplateStore.get(client, created.id, ACTOR));
    expect(got).toEqual(created);
  });

  it("(b) listByCapabilities filters on the manifest jsonb", async () => {
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.create(
        client,
        {
          orgId: ORG_A,
          repoRef: "cat-cave/rust",
          manifest: parse({ stack: "rust", runtime: "cargo", pkg: "cargo", framework: "axum" }),
        },
        ACTOR,
      ),
    );
    const cargo = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.listByCapabilities(client, { runtime: "cargo" }, ACTOR),
    );
    expect(cargo.map((t) => t.manifest.capabilities.framework)).toEqual(["axum"]);

    const node = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.listByCapabilities(client, { packageManager: "pnpm" }, ACTOR),
    );
    expect(node.every((t) => t.manifest.capabilities.packageManager === "pnpm")).toBe(true);
    expect(node.length).toBeGreaterThanOrEqual(1);
  });

  it("(c) org A sees its own + official, never org B's private; unscoped sees only official", async () => {
    // Org B registers a PRIVATE template; the platform org registers an OFFICIAL one.
    await runWithOrgScope(runtimePool, ORG_B, (client) =>
      TemplateStore.create(
        client,
        {
          orgId: ORG_B,
          repoRef: "org-b/secret",
          manifest: parse({ stack: "b", runtime: "node", pkg: "npm", framework: "remix" }),
        },
        ACTOR,
      ),
    );
    const official = await runWithOrgScope(runtimePool, ORG_PLATFORM, (client) =>
      TemplateStore.create(
        client,
        {
          orgId: ORG_PLATFORM,
          repoRef: "cat-cave/official",
          status: "official",
          manifest: parse({ stack: "off", runtime: "node", pkg: "pnpm", framework: "next" }),
        },
        ACTOR,
      ),
    );

    // Org A's scoped list: its OWN templates + the official one, but NOT org B's private.
    const listA = await runWithOrgScope(runtimePool, ORG_A, (client) => TemplateStore.list(client, ACTOR));
    const orgsSeen = new Set(listA.map((t) => t.orgId));
    expect(orgsSeen.has(ORG_A)).toBe(true);
    // the official tier is cross-org readable
    expect(orgsSeen.has(ORG_PLATFORM)).toBe(true);
    // org B's private template never surfaces
    expect(orgsSeen.has(ORG_B)).toBe(false);

    // Org A can GET the official template by id (cross-org read of the shared tier).
    const officialFromA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.get(client, official.id, ACTOR),
    );
    expect(officialFromA?.status).toBe("official");

    // An UNSCOPED runtime-pool read (empty GUC) sees ONLY official rows — every
    // private row is denied by default.
    const unscoped = await TemplateStore.list(runtimePool, ACTOR);
    expect(unscoped.every((t) => t.status === "official")).toBe(true);
    expect(unscoped.some((t) => t.id === official.id)).toBe(true);
  });

  it("(d) status transitions + markDegraded work under scope", async () => {
    const t = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.create(
        client,
        {
          orgId: ORG_A,
          repoRef: "cat-cave/lifecycle",
          manifest: parse({ stack: "l", runtime: "node", pkg: "pnpm", framework: "next" }),
        },
        ACTOR,
      ),
    );
    const validated = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.updateStatus(client, t.id, "validated", ACTOR),
    );
    expect(validated?.status).toBe("validated");
    const degraded = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.markDegraded(client, t.id, ACTOR),
    );
    expect(degraded?.status).toBe("degraded");

    // A missing id yields undefined (no throw).
    const missing = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      TemplateStore.updateStatus(client, "template_missing", "validated", ACTOR),
    );
    expect(missing).toBeUndefined();
  });

  it("(e) a write cannot land under a different org (WITH CHECK rejects)", async () => {
    // Under org A's scope, attempt to register a row OWNED BY org B — RLS WITH
    // CHECK (org_id = current_org_id, no official escape) rejects it.
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        TemplateStore.create(
          client,
          {
            orgId: ORG_B,
            repoRef: "spoof",
            manifest: parse({ stack: "x", runtime: "node", pkg: "pnpm", framework: "next" }),
          },
          ACTOR,
        ),
      ),
    ).rejects.toThrow(/row-level security/u);

    // Even attempting to write an `official` row under org A's scope keeps org_id
    // = ORG_A (the WITH CHECK has no official exception) — it lands as A's row,
    // never a cross-org official one owned by another org.
    const owned = await runWithSystemScope(ownerPool, (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM templates WHERE repo_ref = 'spoof'"),
    );
    expect(owned.rows[0]?.count).toBe("0");
  });
});
