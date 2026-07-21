// Real-Postgres proof for in-22's reader boundary. The tenant role must see no
// attachment from another organization, even when it knows the full coordinate.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgIntegrationEvidenceReaders } from "../src/engine/postMerge/delivery/integrationEvidence.js";
import { seedMergedRun, seedOrg } from "./helpers/deliveryDagRlsSeed.js";
import { DIGEST, seedBindingLineage } from "./helpers/reconciliationSagaSeed.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_in22_reader_a";
const ORG_B = "org_in22_reader_b";
const PROJECT_A = "project_in22_reader_a";
const PROJECT_B = "project_in22_reader_b";
const DELIVERY_A = "delivery-in22-a";
const DELIVERY_B = "delivery-in22-b";

function databaseName(): string {
  return `tanren_in22_readers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(database: string, runtime = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (runtime) {
    url.username = "tanren_app";
    url.password = APP_PASSWORD;
  }
  return url.toString();
}

async function seedAttachment(
  owner: Pool,
  input: { orgId: string; projectId: string; deliveryRunId: string },
): Promise<void> {
  const suffix = input.orgId.endsWith("_a") ? "a" : "b";
  const runId = `run-in22-${suffix}`;
  const specId = `spec-in22-${suffix}`;
  const decisionId = `decision-in22-${suffix}`;
  const requirementId = `requirement-in22-${suffix}`;
  await seedMergedRun(owner, {
    org: input.orgId,
    project: input.projectId,
    run: runId,
    spec: specId,
    decision: decisionId,
    node: `node-in22-${suffix}`,
    sha: suffix.repeat(40),
    deliveryId: input.deliveryRunId,
  });
  await owner.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality, status)
     VALUES ($1, $2, $3, 'messaging.send', 'product', 'outbound', '{}'::jsonb,
             'behavior_revision', 'behavior-in22', $4, 'policy-v1', 'release_required', 'active')`,
    [input.orgId, requirementId, input.projectId, DIGEST],
  );
  const bindingId = await seedBindingLineage(owner, input.orgId, input.projectId, requirementId);
  await owner.query(
    `INSERT INTO delivery_run_bindings (org_id, project_id, delivery_run_id, binding_id, binding_generation)
     VALUES ($1, $2, $3, $4, 1)`,
    [input.orgId, input.projectId, input.deliveryRunId, bindingId],
  );
  await owner.query(
    `INSERT INTO integration_runtime_attachments
       (org_id, project_id, delivery_run_id, binding_id, binding_generation, deploy_sha)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [input.orgId, input.projectId, input.deliveryRunId, bindingId, suffix.repeat(40)],
  );
}

describeDb("in-22 evidence readers — RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    await seedOrg(owner, ORG_A);
    await seedOrg(owner, ORG_B);
    await seedAttachment(owner, { orgId: ORG_A, projectId: PROJECT_A, deliveryRunId: DELIVERY_A });
    await seedAttachment(owner, { orgId: ORG_B, projectId: PROJECT_B, deliveryRunId: DELIVERY_B });
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("DECISIVE: cross-org evidence reads return zero rows under runWithOrgScope", async () => {
    const raw = await runWithOrgScope(app, ORG_A, (client) =>
      client.query("SELECT binding_id FROM integration_runtime_attachments WHERE org_id = $1", [ORG_B]),
    );
    expect(raw.rowCount).toBe(0);

    const reader = new PgIntegrationEvidenceReaders(app);
    const rows = await reader.readRuntimeAttachments({
      orgId: ORG_A,
      projectId: PROJECT_B,
      runId: "run-in22-b",
      specId: "spec-in22-b",
      deliveryRunId: DELIVERY_B,
      mergeSha: "b".repeat(40),
      deploymentId: "deployment-in22-b",
    });
    expect(rows).toEqual([]);
  });

  it("forces RLS on the durable attachment and redacted-failure tables", async () => {
    const catalog = await owner.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [["integration_evidence_failures", "integration_runtime_attachments", "integration_validation_proofs"]],
    );
    expect(catalog.rows).toEqual([
      { relname: "integration_evidence_failures", relforcerowsecurity: true },
      { relname: "integration_runtime_attachments", relforcerowsecurity: true },
      { relname: "integration_validation_proofs", relforcerowsecurity: true },
    ]);
  });
});
