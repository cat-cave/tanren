// Native design subsystem (WS-D1) — the `design_contracts` store DAL, proven
// against a REAL Postgres (no SQL mocks), like the templates registry DAL test.
// Proves end-to-end:
//   (a) DesignContractStore.create/get/getLatest/listVersions round-trip under an
//       org scope, decoded to the contract shape (contract jsonb re-parsed);
//   (b) VERSIONING — a second create for the same project mints version 2 and
//       getLatest reads the head; listVersions returns newest-first;
//   (c) ORG SCOPE under RLS: org A sees its own contracts but NEVER org B's; an
//       UNSCOPED runtime-pool read sees ZERO rows (deny-by-default empty GUC);
//   (d) WRITES stay org-scoped: org A cannot INSERT a row owned by org B;
//   (e) H2 BLOCKING (unify) — the design contract is PROJECT-scoped: there is
//       exactly ONE head per project, shared across every spec type (scaffold
//       specs need product identity for README naming; feature specs need it
//       for behavior grading). Migration 0028 collapsed the broken per-mode
//       key that silently no-op'd for scaffold/build/deploy specs.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the templates / R1 / R2 cohort tests.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { DesignContractStore } from "../src/engine/repositories/index.js";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_design_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_design_a";
const ORG_B = "org_design_b";
const PROJECT_A = "project_design_a";
const PROJECT_A2 = "project_design_a2";
const PROJECT_B = "project_design_b";
const ACTOR = { kind: "operator" as const };

function contract(domain: string, identity: string): DesignContractV1 {
  return parseDesignContract({
    version: 1,
    domain,
    identity,
    intent: `the design north star for ${identity}`,
    principles: ["no AI-slop"],
    constraints: [],
    // THE MOAT — first-class persona/behavior id links round-trip through the jsonb.
    personaRefs: ["persona_x"],
    behaviorRefs: ["behavior_y"],
    dimensions: [
      {
        key: "tokens",
        label: "Design tokens",
        intent: "a restrained palette",
        guidance: "",
        personaRefs: ["persona_x"],
      },
    ],
  });
}

describeDb("design_contracts DAL — versioned, org-scoped", () => {
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

    for (const org of [ORG_A, ORG_B]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
    }
    for (const [project, org] of [
      [PROJECT_A, ORG_A],
      [PROJECT_A2, ORG_A],
      [PROJECT_B, ORG_B],
    ]) {
      await ownerPool.query(
        `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
         VALUES ($1, 'p', 'https://github.com/cat-cave/fixture', 'main', 'runner:v0', $2, '{}'::jsonb)`,
        [project, org],
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
      DesignContractStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A, contract: contract("saas-web", "console") },
        ACTOR,
      ),
    );
    expect(created.orgId).toBe(ORG_A);
    expect(created.version).toBe(1);
    expect(created.domain).toBe("saas-web");
    expect(created.contract.dimensions[0]?.key).toBe("tokens");
    // THE MOAT — the persona/behavior id links survive the jsonb round-trip.
    expect(created.contract.personaRefs).toEqual(["persona_x"]);
    expect(created.contract.behaviorRefs).toEqual(["behavior_y"]);
    expect(created.contract.dimensions[0]?.personaRefs).toEqual(["persona_x"]);

    const got = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.get(client, created.id, ACTOR),
    );
    expect(got).toEqual(created);
  });

  it("(b) a second create mints version 2; getLatest reads the head; listVersions is newest-first", async () => {
    const v2 = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A, contract: contract("saas-web", "console-v2") },
        ACTOR,
      ),
    );
    expect(v2.version).toBe(2);

    const latest = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.getLatest(client, PROJECT_A, ACTOR),
    );
    expect(latest?.version).toBe(2);
    expect(latest?.contract.identity).toBe("console-v2");

    const versions = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.listVersions(client, PROJECT_A, ACTOR),
    );
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("(c) org A never sees org B's contracts; an unscoped read sees ZERO rows", async () => {
    const bContract = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      DesignContractStore.create(
        client,
        { orgId: ORG_B, projectId: PROJECT_B, contract: contract("mobile-game", "cozy") },
        ACTOR,
      ),
    );

    // Org A cannot read org B's contract by id (deny-by-default).
    const crossRead = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.get(client, bContract.id, ACTOR),
    );
    expect(crossRead).toBeUndefined();

    // Org A's getLatest for org B's project sees nothing (RLS denies the rows).
    const crossLatest = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.getLatest(client, PROJECT_B, ACTOR),
    );
    expect(crossLatest).toBeUndefined();

    // An UNSCOPED runtime-pool read (empty GUC) sees ZERO rows — every row is denied.
    const unscoped = await DesignContractStore.listVersions(runtimePool, PROJECT_A, ACTOR);
    expect(unscoped).toEqual([]);
  });

  it("(d) writes stay org-scoped — org A cannot INSERT a row owned by org B", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        DesignContractStore.create(
          client,
          { orgId: ORG_B, projectId: PROJECT_A2, contract: contract("saas-web", "spoof") },
          ACTOR,
        ),
      ),
      // The RLS WITH CHECK rejects an INSERT whose org_id ≠ the scoped org.
    ).rejects.toThrow(/row-level security|violates|new row/iu);
  });

  // H2 BLOCKING (unify): the contract is PROJECT-scoped — one head per project,
  // shared across every spec type. Multiple `create` calls on the same project
  // mint monotonic versions and `getLatest` returns the highest, regardless of
  // any downstream spec's writer-prompt mode (which lives in the writer prompt,
  // not the persistence key).
  it("(e) H2: project-scoped versioning — one head per project, monotonic version numbering", async () => {
    // Use PROJECT_A2 (unused by earlier tests) for a clean versioning surface.
    const v1 = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A2, contract: contract("saas-web", "v1") },
        ACTOR,
      ),
    );
    expect(v1.version).toBe(1);

    const v2 = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A2, contract: contract("saas-web", "v2") },
        ACTOR,
      ),
    );
    expect(v2.version).toBe(2);

    // getLatest returns the highest version — one head per project.
    const head = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.getLatest(client, PROJECT_A2, ACTOR),
    );
    expect(head?.version).toBe(2);
    expect(head?.contract.identity).toBe("v2");

    // listVersions returns the full history newest-first.
    const versions = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      DesignContractStore.listVersions(client, PROJECT_A2, ACTOR),
    );
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });
});
