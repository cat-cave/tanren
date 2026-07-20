// Real-Postgres proof for the in-9/in-10 capability_prepare node. The driver runs
// as the non-superuser tanren_app role (RLS genuinely enforced); the system pool
// (owner) only resolves a project's org. Proves: materialize + enqueue on a present
// grant; awaiting_grant park (+ actionable request) on an absent grant; the
// idempotent, fail-closed grant-wake; capability dependency resolution (satisfied →
// prepares; unresolved → fails closed); and cross-org isolation.

import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityPrepareDriver } from "../src/engine/integrations/capabilityPrepare.js";
import { buildDagWalker } from "../src/engine/dag/walker.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_capprep_a";
const ORG_B = "org_capprep_b";
const DIGEST = `sha256:${"a".repeat(64)}`;

const SLACK_PRODUCT_DESIRED_STATE = {
  version: 1,
  providerPolicy: { allowed: ["slack"], forbidden: ["twilio"] },
  environments: ["test"],
  requiredOperations: ["chat.postMessage"],
  requiredScopes: ["chat:write"],
};

function dbName(): string {
  return `tanren_capprep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describeDb("capability_prepare (in-9/in-10) — tenant-scoped materialize + grant-wake", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let driver: CapabilityPrepareDriver;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    // The driver runs on the RLS-enforced app pool; org resolution uses the owner
    // pool as the BYPASSRLS system pool.
    setSystemPool(ownerPool);
    driver = new CapabilityPrepareDriver(appPool);

    await seedOrgProject(ownerPool, ORG_A, "proj_mat");
    await seedRequirement(ownerPool, ORG_A, "proj_mat", "req_mat", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_mat", "slack", "product", "test");

    await seedOrgProject(ownerPool, ORG_A, "proj_wake");
    await seedRequirement(ownerPool, ORG_A, "proj_wake", "req_wake", "messaging.send", "product");

    await seedOrgProject(ownerPool, ORG_A, "proj_dep_fail");
    await seedRequirement(ownerPool, ORG_A, "proj_dep_fail", "req_depfail_parent", "messaging.send", "product");
    await seedRequirement(ownerPool, ORG_A, "proj_dep_fail", "req_depfail_child", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_dep_fail", "slack", "product", "test");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_dep_fail", "req_depfail_parent", "needs_attention");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_dep_fail", "req_depfail_child", "pending");
    await seedCapabilityDep(ownerPool, ORG_A, "proj_dep_fail", "req_depfail_child", "req_depfail_parent");

    await seedOrgProject(ownerPool, ORG_A, "proj_dep_ok");
    await seedRequirement(ownerPool, ORG_A, "proj_dep_ok", "req_depok_parent", "messaging.send", "product");
    await seedRequirement(ownerPool, ORG_A, "proj_dep_ok", "req_depok_child", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_dep_ok", "slack", "product", "test");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_dep_ok", "req_depok_parent", "ready");
    await seedCapabilityNode(ownerPool, ORG_A, "proj_dep_ok", "req_depok_child", "pending");
    await seedCapabilityDep(ownerPool, ORG_A, "proj_dep_ok", "req_depok_child", "req_depok_parent");

    // Insufficient grant: present + active but MISSING the required chat:write scope.
    await seedOrgProject(ownerPool, ORG_A, "proj_insuff");
    await seedRequirement(ownerPool, ORG_A, "proj_insuff", "req_insuff", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_insuff", "slack", "product", "test", { scopes: ["channels:read"] });

    // Expired grant: covers scopes/ops/capability but the grant generation is expired.
    await seedOrgProject(ownerPool, ORG_A, "proj_expired");
    await seedRequirement(ownerPool, ORG_A, "proj_expired", "req_expired", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_expired", "slack", "product", "test", {
      grantExpiresSql: "now() - interval '1 hour'",
    });

    // Production-seam pin: an ACTIVE project walked through the real buildDagWalker.
    await seedOrgProject(ownerPool, ORG_A, "proj_walker");
    await seedRequirement(ownerPool, ORG_A, "proj_walker", "req_walker", "messaging.send", "product");
    await seedGrantLineage(ownerPool, ORG_A, "proj_walker", "slack", "product", "test");

    // Cross-org control: org B has its own requirement; org-A driver runs must never
    // touch it.
    await seedOrgProject(ownerPool, ORG_B, "proj_b");
    await seedRequirement(ownerPool, ORG_B, "proj_b", "req_b", "messaging.send", "product");
  }, 60_000);

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

  it("materializes a capability node and enqueues prepare work when the grant is present", async () => {
    const summary = await driver.prepare("proj_mat");
    expect(summary.materialized).toBe(1);
    expect(summary.enqueued).toBe(1);

    const nodes = await ownerPool.query<{ id: string; status: string; wait_reason: string | null }>(
      "SELECT id, status, wait_reason FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_mat'",
      [ORG_A],
    );
    expect(nodes.rows).toEqual([{ id: "capnode_req_mat_test", status: "enqueued", wait_reason: null }]);

    const recon = await ownerPool.query<{ phase: string; status: string; requirement_id: string }>(
      "SELECT phase, status, requirement_id FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_mat'",
      [ORG_A],
    );
    expect(recon.rows).toEqual([{ phase: "discover", status: "pending", requirement_id: "req_mat" }]);

    // A second pass is a no-op: still one node, still one reconciliation row.
    const again = await driver.prepare("proj_mat");
    expect(again.materialized).toBe(0);
    expect(again.enqueued).toBe(0);
    const reconCount = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_mat'",
      [ORG_A],
    );
    expect(reconCount.rows[0]?.n).toBe("1");
  });

  it("parks a grant-absent node as awaiting_grant and emits the actionable request", async () => {
    const summary = await driver.prepare("proj_wake");
    expect(summary.awaitingGrant).toBe(1);
    expect(summary.enqueued).toBe(0);

    const nodes = await ownerPool.query<{ status: string; wait_reason: string | null }>(
      "SELECT status, wait_reason FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_wake'",
      [ORG_A],
    );
    expect(nodes.rows[0]?.status).toBe("awaiting_grant");
    expect(nodes.rows[0]?.wait_reason).toMatch(/^grant_absent:slack:product\/test$/u);

    const recon = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_wake'",
      [ORG_A],
    );
    expect(recon.rows[0]?.n).toBe("0");

    const events = await ownerPool.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE org_id = $1 AND project_id = 'proj_wake' ORDER BY id",
      [ORG_A],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["integration.grant.requested"]);

    // Re-preparing while still parked does NOT re-emit the request (transition-only).
    await driver.prepare("proj_wake");
    const eventsAfter = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE org_id = $1 AND project_id = 'proj_wake' AND event_type = 'integration.grant.requested'",
      [ORG_A],
    );
    expect(eventsAfter.rows[0]?.n).toBe("1");
  });

  it("wakes the parked node when the grant arrives, idempotently and fail-closed", async () => {
    // Grant arrives.
    await seedGrantLineage(ownerPool, ORG_A, "proj_wake", "slack", "product", "test");

    const wokeFirst = await driver.wakeForGrant(ORG_A, "proj_wake", "slack");
    expect(wokeFirst).toBe(1);

    const node = await ownerPool.query<{ status: string; wait_reason: string | null }>(
      "SELECT status, wait_reason FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_wake'",
      [ORG_A],
    );
    expect(node.rows).toEqual([{ status: "enqueued", wait_reason: null }]);

    const recon = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_wake'",
      [ORG_A],
    );
    expect(recon.rows[0]?.n).toBe("1");

    // A second wake is a NO-OP: the node is no longer awaiting_grant, so nothing is
    // re-evaluated and no duplicate reconciliation is enqueued.
    const wokeSecond = await driver.wakeForGrant(ORG_A, "proj_wake", "slack");
    expect(wokeSecond).toBe(0);
    const reconAfter = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_wake'",
      [ORG_A],
    );
    expect(reconAfter.rows[0]?.n).toBe("1");
  });

  it("parks awaiting_grant (never enqueues) when a present grant lacks a required scope", async () => {
    const summary = await driver.prepare("proj_insuff");
    expect(summary.awaitingGrant).toBe(1);
    expect(summary.enqueued).toBe(0);
    const node = await ownerPool.query<{ status: string; wait_reason: string | null }>(
      "SELECT status, wait_reason FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_insuff'",
      [ORG_A],
    );
    expect(node.rows[0]?.status).toBe("awaiting_grant");
    expect(node.rows[0]?.wait_reason).toMatch(/^insufficient_scopes:/u);
    const recon = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_insuff'",
      [ORG_A],
    );
    expect(recon.rows[0]?.n).toBe("0");
  });

  it("parks awaiting_grant (never enqueues) when the grant is expired", async () => {
    const summary = await driver.prepare("proj_expired");
    expect(summary.awaitingGrant).toBe(1);
    expect(summary.enqueued).toBe(0);
    const node = await ownerPool.query<{ status: string; wait_reason: string | null }>(
      "SELECT status, wait_reason FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_expired'",
      [ORG_A],
    );
    expect(node.rows[0]?.status).toBe("awaiting_grant");
    expect(node.rows[0]?.wait_reason).toMatch(/^grant_expired:/u);
  });

  it("fails closed when a capability dependency is unresolved, then recovers when the parent recovers", async () => {
    const summary = await driver.prepare("proj_dep_fail");
    expect(summary.needsAttention).toBe(1);
    expect(summary.enqueued).toBe(0);

    const child = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_depfail_child_test'",
      [ORG_A],
    );
    expect(child.rows[0]?.status).toBe("needs_attention");
    const recon = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_dep_fail'",
      [ORG_A],
    );
    expect(recon.rows[0]?.n).toBe("0");

    // A second prepare while the parent is STILL needs_attention leaves the child stuck.
    await driver.prepare("proj_dep_fail");
    const stillStuck = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_depfail_child_test'",
      [ORG_A],
    );
    expect(stillStuck.rows[0]?.status).toBe("needs_attention");

    // Parent recovers to ready (as the reconciliation saga would) → the dep-caused
    // child re-evaluates and prepares.
    await ownerPool.query(
      "UPDATE capability_nodes SET status = 'ready' WHERE org_id = $1 AND id = 'capnode_req_depfail_parent_test'",
      [ORG_A],
    );
    const recovered = await driver.prepare("proj_dep_fail");
    expect(recovered.enqueued).toBe(1);
    const childAfter = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_depfail_child_test'",
      [ORG_A],
    );
    expect(childAfter.rows[0]?.status).toBe("enqueued");
  });

  it("prepares a node whose dependency is satisfied (parent ready) and grant present", async () => {
    const summary = await driver.prepare("proj_dep_ok");
    expect(summary.enqueued).toBe(1);

    const child = await ownerPool.query<{ status: string }>(
      "SELECT status FROM capability_nodes WHERE org_id = $1 AND id = 'capnode_req_depok_child_test'",
      [ORG_A],
    );
    expect(child.rows[0]?.status).toBe("enqueued");
    const recon = await ownerPool.query<{ requirement_id: string }>(
      "SELECT requirement_id FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_dep_ok'",
      [ORG_A],
    );
    expect(recon.rows.map((r) => r.requirement_id)).toEqual(["req_depok_child"]);
  });

  it("runs the integration phase through the real production walker seam (finding-3 pin)", async () => {
    // The production construction seam: buildDagWalker wiring a real
    // CapabilityPrepareDriver, walking an ACTIVE project. The walk must materialize +
    // enqueue the capability graph via the integration phase (never a dead path).
    const walker = buildDagWalker(appPool, { integrationPhase: new CapabilityPrepareDriver(appPool) });
    await walker.walk("proj_walker");

    const nodes = await ownerPool.query<{ id: string; status: string }>(
      "SELECT id, status FROM capability_nodes WHERE org_id = $1 AND project_id = 'proj_walker'",
      [ORG_A],
    );
    expect(nodes.rows).toEqual([{ id: "capnode_req_walker_test", status: "enqueued" }]);
    const recon = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_reconciliations WHERE org_id = $1 AND project_id = 'proj_walker'",
      [ORG_A],
    );
    expect(recon.rows[0]?.n).toBe("1");
  });

  it("never touches another org's rows (cross-org isolation)", async () => {
    // Every org-A prepare above has run; org B must have zero capability nodes and
    // zero reconciliations.
    const bNodes = await ownerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM capability_nodes WHERE org_id = $1",
      [ORG_B],
    );
    expect(bNodes.rows[0]?.n).toBe("0");

    // Preparing the org-B project materializes ONLY org-B's node.
    const summary = await driver.prepare("proj_b");
    expect(summary.materialized).toBe(1);
    const bNodesAfter = await ownerPool.query<{ requirement_id: string }>(
      "SELECT requirement_id FROM capability_nodes WHERE org_id = $1",
      [ORG_B],
    );
    expect(bNodesAfter.rows.map((r) => r.requirement_id)).toEqual(["req_b"]);
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
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/capprep.git', $2)`,
    [projectId, orgId],
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
    [orgId, requirementId, projectId, capability, plane, JSON.stringify(SLACK_PRODUCT_DESIRED_STATE), DIGEST],
  );
}

interface GrantLineageOptions {
  /** Granted provider scopes (default covers the golden requirement's chat:write). */
  scopes?: string[];
  /** Grant-generation expiry (default none). Pass a past interval string to expire it. */
  grantExpiresSql?: string;
}

async function seedGrantLineage(
  pool: Pool,
  orgId: string,
  projectId: string,
  providerKind: string,
  plane: string,
  environment: string,
  options: GrantLineageOptions = {},
): Promise<void> {
  const connectionId = `conn_${projectId}`;
  const grantId = `grant_${projectId}`;
  const scopes = options.scopes ?? ["chat:write"];
  const expiresSql = options.grantExpiresSql ?? "NULL";
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
             $5::text[], 'policy.v1', 'consent.v1', 'admin', now(), ${expiresSql}, 'active')`,
    [orgId, providerKind, connectionId, grantId, scopes],
  );
  await pool.query(
    `INSERT INTO project_integration_grant_selections
       (org_id, project_id, provider_kind, connection_id, auth_generation, grant_id, grant_generation, selected_by)
     VALUES ($1, $2, $3, $4, 1, $5, 1, 'test')`,
    [orgId, projectId, providerKind, connectionId, grantId],
  );
}

async function seedCapabilityNode(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  status: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_nodes
       (org_id, id, project_id, requirement_id, environment, executor_kind, desired_state_hash,
        status, priority, generation)
     VALUES ($1, $2, $3, $4, 'test', 'provider_operation', $5, $6, 0, 1)`,
    [orgId, `capnode_${requirementId}_test`, projectId, requirementId, DIGEST, status],
  );
}

async function seedCapabilityDep(
  pool: Pool,
  orgId: string,
  projectId: string,
  childRequirementId: string,
  parentRequirementId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_node_dependencies
       (org_id, project_id, capability_node_id, depends_on_capability_node_id)
     VALUES ($1, $2, $3, $4)`,
    [orgId, projectId, `capnode_${childRequirementId}_test`, `capnode_${parentRequirementId}_test`],
  );
}
