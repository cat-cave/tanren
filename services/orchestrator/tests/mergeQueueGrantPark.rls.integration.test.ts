// in-18 — Real-Postgres proof for the NON-CLOGGING integration-grant park/dequeue
// disposition on the native merge queue. A spec/integration unit BLOCKED on an
// integration grant (its capability node is `awaiting_grant`) must NOT clog the queue:
// it is PARKED under the distinct non-terminal `parked_grant` disposition; OTHER queued
// units dequeue past it; DEPENDENTS stay behind it; and it is RE-ADMITTED only when its
// grant genuinely arrives (in-9's grantCovers-gated node advancement).
//
// The model runs on the RLS-enforced `tanren_app` role (NOBYPASSRLS) so the capability
// join is genuinely tenant-isolated; the owner pool is the BYPASSRLS system pool used
// only to resolve a project's org (and to seed fixtures).
//
// FAIL-CLOSED PROOFS:
//   (a) a grant-blocked unit PARKS and is never a merge candidate (never merges);
//   (b) an independent ready unit dequeues PAST a parked one (non-clogging);
//   (c) a dependent unit does NOT jump ahead of its parked dependency;
//   (d) re-admission ONLY on a genuinely-covering grant — a partial grant keeps it
//       parked (proven end-to-end through the real CapabilityPrepareDriver + grantCovers);
//   (e) cross-org isolation.

import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { selectNextMerge } from "../src/engine/contracts/mergeCoordinator.js";
import { formBatch } from "../src/engine/contracts/batchMergeCoordinator.js";
import { CapabilityPrepareDriver } from "../src/engine/integrations/capabilityPrepare.js";
import { resolveCredentialRepairProjects } from "../src/engine/merge/subscriber.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_in18_a";
const ORG_B = "org_in18_b";
const DIGEST = `sha256:${"a".repeat(64)}`;

const PRODUCT_DESIRED_STATE = {
  version: 1,
  providerPolicy: { allowed: ["slack"], forbidden: ["twilio"] },
  environments: ["test"],
  requiredOperations: ["chat.postMessage"],
  requiredScopes: ["chat:write"],
};

function dbName(): string {
  return `tanren_in18_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("in-18 merge-queue integration-grant park/dequeue (real PG, RLS)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let model: PgMergeQueueModel;
  let driver: CapabilityPrepareDriver;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    model = new PgMergeQueueModel(appPool);
    driver = new CapabilityPrepareDriver(appPool);

    // ORG_A / PROJECT_A — park + non-clog + dependency-order scenario.
    await seedOrgProject(ownerPool, ORG_A, "proj_a");
    // The grant-blocked unit: spec_blocked → capability node awaiting_grant.
    await seedRequirement(ownerPool, ORG_A, "proj_a", "req_blk", "messaging.send", "product");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_a", "req_blk", "awaiting_grant", "insufficient_scopes:slack");
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_a", "spec_blocked", "run_blocked", 3001, []);
    await seedSpecCapabilityDep(ownerPool, ORG_A, "proj_a", "spec_blocked", "capnode_req_blk_test");
    // An INDEPENDENT ready unit (no capability dependency).
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_a", "spec_free", "run_free", 3002, []);
    // A DEPENDENT unit whose only dependency is the parked spec_blocked.
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_a", "spec_dep", "run_dep", 3003, ["spec_blocked"]);

    // ORG_A / PROJECT_READMIT — end-to-end re-admission through the real driver.
    await seedOrgProject(ownerPool, ORG_A, "proj_readmit");
    await seedRequirement(ownerPool, ORG_A, "proj_readmit", "req_re", "messaging.send", "product");
    // A present-but-INSUFFICIENT grant (missing the required chat:write scope).
    await seedGrantLineage(ownerPool, ORG_A, "proj_readmit", "slack", "product", "test", ["channels:read"]);
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_readmit", "spec_re", "run_re", 3010, []);

    // ORG_A / PROJECT_E2E — end-to-end re-admission through the REAL production trigger
    // (driver.prepare → grantCovers → node advance → integration.grant.linked emit).
    await seedOrgProject(ownerPool, ORG_A, "proj_e2e");
    await seedRequirement(ownerPool, ORG_A, "proj_e2e", "req_e2e", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_e2e", "slack", "product", "test", ["channels:read"]);
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_e2e", "spec_e2e", "run_e2e", 3030, []);

    // ORG_A / PROJECT_ORPHAN — a parked row whose capability rows are later deleted
    // (finding-3 empty-set false-positive control).
    await seedOrgProject(ownerPool, ORG_A, "proj_orphan");
    await seedRequirement(ownerPool, ORG_A, "proj_orphan", "req_orphan", "messaging.send", "product");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_orphan", "req_orphan", "awaiting_grant", "grant_absent:slack");
    await seedSpecRunQueued(model, ownerPool, ORG_A, "proj_orphan", "spec_orphan", "run_orphan", 3040, []);
    await seedSpecCapabilityDep(ownerPool, ORG_A, "proj_orphan", "spec_orphan", "capnode_req_orphan_test");

    // ORG_B — cross-org control. Its own parked unit must survive an ORG_A park pass.
    await seedOrgProject(ownerPool, ORG_B, "proj_b");
    await seedRequirement(ownerPool, ORG_B, "proj_b", "req_b", "messaging.send", "product");
    await seedCapabilityNode(ownerPool, ORG_B, "proj_b", "req_b", "awaiting_grant", "grant_absent:slack");
    await seedSpecRunQueued(model, ownerPool, ORG_B, "proj_b", "spec_b", "run_b", 3020, []);
    await seedSpecCapabilityDep(ownerPool, ORG_B, "proj_b", "spec_b", "capnode_req_b_test");
  }, 90_000);

  afterAll(async () => {
    resetSystemPool();
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

  it("(a) parks a grant-blocked unit under parked_grant and never makes it a merge candidate", async () => {
    // Before parking, loadSnapshot's FAIL-CLOSED defense already excludes the
    // grant-blocked spec from the candidate set — never merged even before parking.
    const before = await model.loadSnapshot("proj_a");
    expect(before.entries.map((e) => e.specId).sort()).toEqual(["spec_dep", "spec_free"]);

    const parked = await model.parkGrantBlocked("proj_a");
    expect(parked).toBe(1);

    const row = await queueRow(ownerPool, ORG_A, "run_blocked");
    expect(row.status).toBe("parked_grant");
    expect(row.park_reason).toMatch(/^integration_grant_blocked:capnode_req_blk_test=insufficient_scopes:slack$/u);

    // Idempotent: a second park pass moves nothing.
    expect(await model.parkGrantBlocked("proj_a")).toBe(0);

    // The parked unit is NEVER selected to merge.
    const snap = await model.loadSnapshot("proj_a");
    expect(snap.entries.some((e) => e.specId === "spec_blocked")).toBe(false);
    expect(selectNextMerge(snap).next?.specId).not.toBe("spec_blocked");
    expect(formBatch(snap, 10).batch.some((e) => e.specId === "spec_blocked")).toBe(false);
  });

  it("(b) lets an INDEPENDENT ready unit dequeue past the parked one (non-clogging)", async () => {
    const snap = await model.loadSnapshot("proj_a");
    // spec_free is independent and ready → it is the merge head even though
    // spec_blocked sits parked ahead of it. The queue is not clogged.
    expect(selectNextMerge(snap).next?.specId).toBe("spec_free");
    expect(formBatch(snap, 10).batch.map((e) => e.specId)).toContain("spec_free");
  });

  it("(c) holds a DEPENDENT unit behind its parked dependency (no jump-ahead)", async () => {
    const snap = await model.loadSnapshot("proj_a");
    // spec_dep depends on the parked spec_blocked (not merged) → it is NOT eligible and
    // is surfaced as blocked-by-dependency, never selected ahead of its dependency.
    const selection = selectNextMerge(snap);
    expect(selection.next?.specId).not.toBe("spec_dep");
    expect(selection.blockedByDependency.map((e) => e.specId)).toContain("spec_dep");
    expect(formBatch(snap, 10).batch.some((e) => e.specId === "spec_dep")).toBe(false);
  });

  it("(d) re-admits ONLY on a genuinely-covering grant — a partial grant keeps it parked", async () => {
    // The insufficient grant → the real grantCovers rejects → node parks awaiting_grant.
    const prep = await driver.prepare("proj_readmit");
    expect(prep.awaitingGrant).toBe(1);
    const node = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_re_test'",
      [ORG_A],
    );
    expect(node.rows[0]?.status).toBe("awaiting_grant");

    // The merge unit parks and STAYS parked under the partial grant (fail-closed).
    await seedSpecCapabilityDep(ownerPool, ORG_A, "proj_readmit", "spec_re", "capnode_req_re_test");
    expect(await model.parkGrantBlocked("proj_readmit")).toBe(1);
    expect(await model.reAdmitGrantCovered("proj_readmit")).toBe(0);
    expect((await queueRow(ownerPool, ORG_A, "run_re")).status).toBe("parked_grant");

    // The grant genuinely arrives (scope now covers) → grantCovers passes → in-9's
    // wake advances the node to enqueued → the merge unit is RE-ADMITTED.
    await ownerPool.query(
      "UPDATE org_integration_grant_generations SET provider_scopes = ARRAY['chat:write'] WHERE org_id = $1 AND grant_id = 'grant_proj_readmit'",
      [ORG_A],
    );
    expect(await driver.wakeForGrant(ORG_A, "proj_readmit", "slack")).toBe(1);
    expect(await model.reAdmitGrantCovered("proj_readmit")).toBe(1);
    const readmitted = await queueRow(ownerPool, ORG_A, "run_re");
    expect(readmitted.status).toBe("queued");
    expect(readmitted.park_reason).toBeNull();
    // Now a genuine merge candidate again.
    const snap = await model.loadSnapshot("proj_readmit");
    expect(snap.entries.map((e) => e.specId)).toEqual(["spec_re"]);
  });

  it("(e) an ORG_A park pass never touches ORG_B's rows (cross-org isolation)", async () => {
    await model.parkGrantBlocked("proj_a");
    await model.reAdmitGrantCovered("proj_a");
    // ORG_B's grant-blocked unit is untouched by ORG_A passes: still queued (never
    // parked by A) — proving the park/re-admit is strictly tenant-scoped.
    const b = await queueRow(ownerPool, ORG_B, "run_b");
    expect(b.status).toBe("queued");
    // ORG_B parks only its own unit when driven for ORG_B.
    expect(await model.parkGrantBlocked("proj_b")).toBe(1);
    expect((await queueRow(ownerPool, ORG_B, "run_b")).status).toBe("parked_grant");
    // ORG_A's readmitted unit is unaffected.
    expect((await queueRow(ownerPool, ORG_A, "run_re")).status).toBe("queued");
  });

  it("(f) END-TO-END: a covering grant arriving drives node advance → grant.linked emit → wake → re-admit", async () => {
    // Park spec_e2e on the insufficient grant (real prepare → awaiting_grant node).
    await driver.prepare("proj_e2e");
    await seedSpecCapabilityDep(ownerPool, ORG_A, "proj_e2e", "spec_e2e", "capnode_req_e2e_test");
    expect(await model.parkGrantBlocked("proj_e2e")).toBe(1);
    expect((await queueRow(ownerPool, ORG_A, "run_e2e")).status).toBe("parked_grant");

    // The covering grant ARRIVES. The REAL production integration phase (driver.prepare)
    // re-runs grantCovers → advances the node awaiting_grant→enqueued AND emits the
    // durable integration.grant.linked wake (NOT a hand-fired phantom event).
    await ownerPool.query(
      "UPDATE org_integration_grant_generations SET provider_scopes = ARRAY['chat:write'] WHERE org_id = $1 AND grant_id = 'grant_proj_e2e'",
      [ORG_A],
    );
    await driver.prepare("proj_e2e");
    const node = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_e2e_test'",
      [ORG_A],
    );
    expect(node.rows[0]?.status).toBe("enqueued");

    // The emit is a REAL row; the merge coordinator's wake recognizer maps it to the
    // project (the exact path the subscriber runs on the events NOTIFY).
    const evt = await ownerPool.query<{ id: string; payload: Record<string, unknown> }>(
      "SELECT id, payload FROM events WHERE org_id = $1 AND project_id = 'proj_e2e' AND event_type = 'integration.grant.linked' ORDER BY id DESC LIMIT 1",
      [ORG_A],
    );
    const eventId = evt.rows[0]?.id;
    expect(eventId).toBeDefined();
    expect(evt.rows[0]?.payload["providerKind"]).toBe("slack");
    expect(await resolveCredentialRepairProjects(ownerPool, eventId!)).toEqual(["proj_e2e"]);

    // The woken coordinate pass re-admits the parked unit (node now covered).
    expect(await model.reAdmitGrantCovered("proj_e2e")).toBe(1);
    expect((await queueRow(ownerPool, ORG_A, "run_e2e")).status).toBe("queued");
  });

  it("(g) a parked row whose capability rows were DELETED does NOT re-admit (no empty-set false positive)", async () => {
    expect(await model.parkGrantBlocked("proj_orphan")).toBe(1);
    expect((await queueRow(ownerPool, ORG_A, "run_orphan")).status).toBe("parked_grant");
    // Delete the spec→node link + the node — zero surviving capability rows.
    await ownerPool.query("DELETE FROM spec_capability_dependencies WHERE org_id = $1 AND project_id = 'proj_orphan'", [
      ORG_A,
    ]);
    await ownerPool.query("DELETE FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_orphan'", [ORG_A]);
    // No POSITIVE coverage evidence → the vacuous NOT-EXISTS is not enough → stays parked.
    expect(await model.reAdmitGrantCovered("proj_orphan")).toBe(0);
    expect((await queueRow(ownerPool, ORG_A, "run_orphan")).status).toBe("parked_grant");
  });
});

async function seedOrgProject(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id, config)
     VALUES ($1, $1, 'https://example.com/in18.git', $2, $3::jsonb)`,
    [projectId, orgId, JSON.stringify({ mergeIntegration: "native_queue" })],
  );
}

async function seedRequirement(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  capability: string,
  plane: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, $4, $5, 'outbound', $6::jsonb,
             'design_contract', $2, $7, 'policy-v1', 'release_required')`,
    [orgId, requirementId, projectId, capability, plane, JSON.stringify(PRODUCT_DESIRED_STATE), DIGEST],
  );
}

async function seedCapabilityNode(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  status: string,
  waitReason: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_nodes
       (org_id, id, project_id, requirement_id, environment, executor_kind, desired_state_hash,
        status, wait_reason, priority, generation)
     VALUES ($1, $2, $3, $4, 'test', 'provider_operation', $5, $6, $7, 0, 1)`,
    [orgId, `capnode_${requirementId}_test`, projectId, requirementId, DIGEST, status, waitReason],
  );
}

async function seedSpecRunQueued(
  model: PgMergeQueueModel,
  pool: Pool,
  orgId: string,
  projectId: string,
  specId: string,
  runId: string,
  prNumber: number,
  dependsOn: string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status, depends_on)
     VALUES ($1, $2, $3, 'in18', 'in18 park fixture', 'in_flight', $4::text[])`,
    [specId, projectId, orgId, dependsOn],
  );
  await pool.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'ci', 'main', 'completed')`,
    [runId, specId, projectId, orgId],
  );
  const { created } = await model.enqueue({
    projectId,
    runId,
    specId,
    prUrl: `https://example.com/in18/pull/${prNumber}`,
    prNumber,
  });
  if (!created) throw new Error(`fixture enqueue for ${runId} was not created`);
}

async function seedSpecCapabilityDep(
  pool: Pool,
  orgId: string,
  projectId: string,
  specId: string,
  capabilityNodeId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO spec_capability_dependencies (org_id, project_id, spec_id, capability_node_id)
     VALUES ($1, $2, $3, $4)`,
    [orgId, projectId, specId, capabilityNodeId],
  );
}

async function seedGrantLineage(
  pool: Pool,
  orgId: string,
  projectId: string,
  providerKind: string,
  plane: string,
  environment: string,
  scopes: string[],
): Promise<void> {
  const connectionId = `conn_${projectId}`;
  const grantId = `grant_${projectId}`;
  await pool.query(
    `INSERT INTO org_integration_connections
       (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
        health, status, current_auth_generation, owner_id)
     VALUES ($1, $2, $3, $4, 'team', 'Test Workspace', 'healthy', 'active', 1, 'owner')`,
    [orgId, connectionId, providerKind, `principal_${projectId}`],
  );
  await pool.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
     VALUES ($1, $2, $3, 1, $4, 'bot_token', 'active')`,
    [orgId, providerKind, connectionId, `secret://org/${orgId}/${providerKind}/token/g/1`],
  );
  await pool.query(
    `INSERT INTO org_integration_grants
       (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 'active')`,
    [orgId, grantId, providerKind, connectionId, plane, environment],
  );
  await pool.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, policy_revision, consent_revision, consent_actor_id, consented_at, expires_at, status)
     VALUES ($1, $2, $3, $4, 1, ARRAY['messaging.send'], ARRAY['chat.postMessage'],
             $5::text[], 'policy.v1', 'consent.v1', 'admin', now(), NULL, 'active')`,
    [orgId, providerKind, connectionId, grantId, scopes],
  );
  await pool.query(
    `INSERT INTO project_integration_grant_selections
       (org_id, project_id, provider_kind, connection_id, auth_generation, grant_id, grant_generation, selected_by)
     VALUES ($1, $2, $3, $4, 1, $5, 1, 'test')`,
    [orgId, projectId, providerKind, connectionId, grantId],
  );
}

async function queueRow(
  pool: Pool,
  orgId: string,
  runId: string,
): Promise<{ status: string; park_reason: string | null }> {
  const result = await pool.query<{ status: string; park_reason: string | null }>(
    "SELECT status, park_reason FROM merge_queue WHERE org_id = $1 AND run_id = $2",
    [orgId, runId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no merge_queue row for ${runId}`);
  return row;
}
