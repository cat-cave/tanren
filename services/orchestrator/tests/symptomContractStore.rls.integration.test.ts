// cspell:ignore scontract iloop
// PG-gated tenant proof for the immutable, org-scoped symptom-contract store.
// Run with TANREN_RLS_DB_TEST=1; the ordinary test gate skips this suite.

import { migrate, runWithOrgScope } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { symptomContractHash, type SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_symptom_contract_a";
const ORG_B = "org_symptom_contract_b";
const PROJECT_A = "project_symptom_contract_a";
const PROJECT_B = "project_symptom_contract_b";
const SOURCE_A = "source_symptom_contract_a";
const SOURCE_B = "source_symptom_contract_b";
const LOOP_A = "iloop_symptom_contract_a";
const LOOP_B = "iloop_symptom_contract_b";

function dbName(): string {
  return `tanren_symptom_contract_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withAppRole(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seedTenant(
  pool: Pool,
  orgId: string,
  projectId: string,
  sourceId: string,
  issueLoopId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [projectId, orgId],
  );
  await pool.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'symptom source')`,
    [sourceId, orgId, projectId],
  );
  await pool.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint,
        severity, state, resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'high', 'open', 'active_causal', 1, now())`,
    [orgId, issueLoopId, projectId, sourceId, `external-${issueLoopId}`, `fingerprint-${issueLoopId}`],
  );
}

const CONTRACT: SymptomContractV1 = {
  version: 1,
  issueLoopId: LOOP_A,
  target: { environment: "preview", surface: "checkout", route: "/checkout" },
  expectedFailingObservation: { status: 500, body: { error: "payment_failed" } },
  expectedCorrectedObservation: { status: 200, body: { completed: true } },
  proofPolicy: "active_causal",
  sourceRevision: "github-revision-17",
  baselineRequired: true,
};

describeDb("symptom_contracts store — immutable, org-scoped", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let store: SymptomContractStore;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withAppRole(ADMIN_URL, database) });
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SOURCE_A, LOOP_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B, SOURCE_B, LOOP_B);
    store = new SymptomContractStore(appPool);
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

  it("persists deterministic hashes, rejects mutation, isolates orgs, and emits transitions", async () => {
    const created = await store.create({
      orgId: ORG_A,
      projectId: PROJECT_A,
      contract: CONTRACT,
      authorTaskId: "task-author-1",
    });
    expect(created.state).toBe("authored");
    expect(created.canonicalHash).toBe(symptomContractHash(CONTRACT));

    const fetched = await store.get(ORG_A, created.id);
    expect(fetched?.canonicalHash).toBe(symptomContractHash(CONTRACT));
    expect(fetched?.contract).toEqual(CONTRACT);

    const boundFragment = await store.bindFragment({
      orgId: ORG_A,
      contractId: created.id,
      fragmentId: "fragment-http-probe",
      version: 2,
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conformanceResult: "pass",
    });
    expect(boundFragment.version).toBe(2);
    expect(await store.listFragments(ORG_A, created.id)).toHaveLength(1);

    await expect(
      runWithOrgScope(appPool, ORG_A, (client) =>
        client.query("UPDATE symptom_contracts SET state = 'validated' WHERE org_id = $1 AND id = $2", [
          ORG_A,
          created.id,
        ]),
      ),
    ).rejects.toThrow(/immutable|append-only|rejected/iu);

    const validated = await store.markValidated({
      orgId: ORG_A,
      contractId: created.id,
      validationTaskId: "task-validate-1",
    });
    const superseded = await store.markSuperseded({
      orgId: ORG_A,
      contractId: validated.id,
      supersededByContractId: "scontract_replacement_1",
    });
    expect(validated.state).toBe("validated");
    expect(superseded.state).toBe("superseded");
    expect(await store.listVersions(ORG_A, LOOP_A)).toHaveLength(3);

    expect(await store.getByIssueLoop(ORG_B, LOOP_A)).toBeUndefined();
    expect(await store.listVersions(ORG_B, LOOP_A)).toEqual([]);
    expect(await store.get(ORG_B, created.id)).toBeUndefined();

    const events = await runWithOrgScope(appPool, ORG_A, async (client) => {
      const result = await client.query<{ event_type: string }>(
        `SELECT event_type
           FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type = ANY($3::text[])
          ORDER BY id`,
        [ORG_A, PROJECT_A, ["symptom.contract.authored", "symptom.contract.validated", "symptom.contract.superseded"]],
      );
      return result.rows.map((row) => row.event_type);
    });
    expect(events).toEqual(["symptom.contract.authored", "symptom.contract.validated", "symptom.contract.superseded"]);
  });
});
