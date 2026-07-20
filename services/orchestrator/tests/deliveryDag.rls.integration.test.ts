// in-17 — REAL-Postgres proof of the durable, resumable post-merge delivery DAG. The
// driver runs as the non-superuser tenant role (`tanren_app`) over the real 0000→0043
// migration chain, consuming the in-16 `delivery_runs` outbox. It proves the node's
// fail-closed doctrine end-to-end:
//   (1) a no-effect delivery drives all nine stages to `completed` and records the signed
//       `delivery.completed` attestation;
//   (2) a release-required product integration whose A3 effect is unobservable DEGRADES
//       (durable, NOT completed) — and a CRASH-style re-drive RESUMES from the last durable
//       stage (never re-running a committed effect) to complete once the effect is
//       observable;
//   (3) an org-A drive never touches an org-B delivery (cross-org RLS isolation).
// Gated on TANREN_RLS_DB_TEST; runs in the RLS phase, not the DB-less unit phase.

import { migrate, resetSystemPool, runWithJobOrgId, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { DeliveryDagDriver } from "../src/engine/postMerge/delivery/deliveryDagDriver.js";
import { contentAddressedEvidenceSigner } from "../src/engine/postMerge/delivery/deliveryEvidence.js";
import { PgDeliverySignals } from "../src/engine/postMerge/delivery/deliverySignals.js";
import type { RunMergeWatcher } from "../src/engine/postMerge/subscriber.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const D = `sha256:${"d".repeat(64)}`;

const ORG_A = "org_delivery_a";
const ORG_B = "org_delivery_b";

function dbName(): string {
  return `tanren_delivery_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const p = new URL(url);
  p.pathname = `/${database}`;
  return p.toString();
}
function appUrl(url: string, database: string): string {
  const p = new URL(url);
  p.username = "tanren_app";
  p.password = APP_PASSWORD;
  p.pathname = `/${database}`;
  return p.toString();
}

/** A no-op idempotent cluster runner that records the runIds it was driven for. */
function recordingRunner(): RunMergeWatcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/require-await
    check: async (runId: string) => {
      calls.push(runId);
    },
  };
}

async function seedOrg(owner: Pool, org: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
}

/** Seed the full lineage + in-16 outbox row for one merged run (as the DB owner). */
async function seedMergedRun(
  owner: Pool,
  args: {
    org: string;
    project: string;
    run: string;
    spec: string;
    decision: string;
    node: string;
    sha: string;
    deliveryId: string;
  },
): Promise<void> {
  const { org, project, run, spec, decision, node, sha, deliveryId } = args;
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [project, org],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $1, $4, 'tree-x', 'ready')`,
    [node, project, org, D],
  );
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
        artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1, $2, $3, $4, 'integration_node', $5, $5, $5, $5, $5, 'v1', 'authorized')`,
    [org, project, decision, node, D],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'in_flight')`,
    [spec, project, org],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch)
     VALUES ($1, $2, $3, $4, 'test', 'main')`,
    [run, spec, project, org],
  );
  // Seed the merged-run signal through the single event-writer seam (not a raw INSERT).
  await runWithJobOrgId(org, () =>
    new PgEventStore(orgScopingPool(owner)).append({
      runId: run,
      specId: spec,
      projectId: project,
      orgId: org,
      eventType: "merge.completed",
      payload: { prUrl: "https://example.com/pr/1", prNumber: 1, integration: "native_queue", mergeSha: sha },
    }),
  );
  await owner.query(
    `INSERT INTO delivery_runs (org_id, id, project_id, authority_decision_id, merge_sha, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [org, deliveryId, project, decision, sha],
  );
}

interface DeliveryRow {
  status: string;
  completed_at: string | null;
}
async function deliveryRow(pool: Pool, org: string, id: string): Promise<DeliveryRow | undefined> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<DeliveryRow>(
      "SELECT status, completed_at FROM delivery_runs WHERE org_id = $1 AND id = $2",
      [org, id],
    );
    return r.rows[0];
  });
}
async function stageStatuses(pool: Pool, org: string, deliveryId: string): Promise<Map<string, string>> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<{ stage: string; status: string }>(
      "SELECT stage, status FROM delivery_stage_attempts WHERE org_id = $1 AND delivery_run_id = $2 ORDER BY ordinal, attempt",
      [org, deliveryId],
    );
    const m = new Map<string, string>();
    // last attempt wins
    for (const row of r.rows) m.set(row.stage, row.status);
    return m;
  });
}
async function eventTypesFor(pool: Pool, org: string, run: string): Promise<string[]> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE org_id = $1 AND run_id = $2 AND event_type LIKE 'delivery.%'",
      [org, run],
    );
    return r.rows.map((x) => x.event_type);
  });
}

describeDb("DeliveryDagDriver — real-Postgres durable resumable delivery DAG", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  function makeDriver(): {
    driver: DeliveryDagDriver;
    deploy: ReturnType<typeof recordingRunner>;
    demo: ReturnType<typeof recordingRunner>;
  } {
    const deploy = recordingRunner();
    const demo = recordingRunner();
    const driver = new DeliveryDagDriver({
      pool: appPool,
      signals: new PgDeliverySignals(appPool),
      deployRunner: deploy,
      demoRunner: demo,
      saga: { driveForOrg: () => Promise.resolve({ stateUnknown: 0, needsAttention: 0 }) },
      evidence: { eventStore: new PgEventStore(orgScopingPool(appPool)), signer: contentAddressedEvidenceSigner },
      claimOwner: "test-owner",
    });
    return { driver, deploy, demo };
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    await seedOrg(ownerPool, ORG_A);
    await seedOrg(ownerPool, ORG_B);
    // (1) happy no-effect delivery for org A.
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_ok",
      run: "run_ok",
      spec: "spec_ok",
      decision: "dec_ok",
      node: "node_ok",
      sha: "a".repeat(40),
      deliveryId: "delivery-dec_ok",
    });
    // (2) release-required degraded → resume for org A.
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_deg",
      run: "run_deg",
      spec: "spec_deg",
      decision: "dec_deg",
      node: "node_deg",
      sha: "b".repeat(40),
      deliveryId: "delivery-dec_deg",
    });
    await ownerPool.query(
      `INSERT INTO integration_requirements
         (org_id, id, project_id, capability, plane, direction, desired_state, source_kind, source_revision_id, source_digest, policy_version, criticality, status)
       VALUES ($1, 'req_deg', $2, 'messaging.send', 'product', 'outbound', '{}'::jsonb, 'behavior_revision', 'br-x', $3, 'v1', 'release_required', 'active')`,
      [ORG_A, "proj_deg", D],
    );
    // (3) org B delivery — must remain untouched by org A drives.
    await seedMergedRun(ownerPool, {
      org: ORG_B,
      project: "proj_b",
      run: "run_b",
      spec: "spec_b",
      decision: "dec_b",
      node: "node_b",
      sha: "c".repeat(40),
      deliveryId: "delivery-dec_b",
    });
  }, 60_000);

  afterAll(async () => {
    resetSystemPool();
    await appPool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  });

  it("completes a no-effect delivery, marks all nine stages succeeded, and records signed evidence", async () => {
    const { driver, deploy, demo } = makeDriver();
    await driver.check("run_ok");

    const row = await deliveryRow(appPool, ORG_A, "delivery-dec_ok");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();

    const stages = await stageStatuses(appPool, ORG_A, "delivery-dec_ok");
    expect(stages.size).toBe(9);
    for (const status of stages.values()) expect(status).toBe("succeeded");

    expect(await eventTypesFor(appPool, ORG_A, "run_ok")).toContain("delivery.completed");
    // The idempotent cluster runners were driven exactly once each.
    expect(deploy.calls).toEqual(["run_ok"]);
    expect(demo.calls).toEqual(["run_ok"]);
  });

  it("fails closed on a release-required integration, then RESUMES to completed without re-running committed stages", async () => {
    // Drive 1: the release-required product integration has no observable A3 effect → degrade.
    const first = makeDriver();
    await first.driver.check("run_deg");
    let row = await deliveryRow(appPool, ORG_A, "delivery-dec_deg");
    expect(row?.status).toBe("degraded");
    expect(row?.completed_at).toBeNull();
    let stages = await stageStatuses(appPool, ORG_A, "delivery-dec_deg");
    // no deploy/demo → no-op confirmed
    expect(stages.get("observe")).toBe("succeeded");
    // the fail-closed gate
    expect(stages.get("record_evidence")).toBe("retry_scheduled");
    const evTypes1 = await eventTypesFor(appPool, ORG_A, "run_deg");
    expect(evTypes1).toContain("delivery.degraded");
    // NEVER complete without the effect
    expect(evTypes1).not.toContain("delivery.completed");
    // deploy cluster driven once
    expect(first.deploy.calls).toEqual(["run_deg"]);

    // The requirement's independent A3 observation becomes available (seam lands / requirement clears).
    await ownerPool.query("DELETE FROM integration_requirements WHERE org_id = $1 AND id = 'req_deg'", [ORG_A]);

    // Drive 2 (crash-style re-drive): resumes from the last durable stage — stages 0..7 are
    // already succeeded and are SKIPPED (their committed effects are NOT re-run), only
    // record_evidence re-runs and now confirms → completed.
    const second = makeDriver();
    await second.driver.check("run_deg");
    row = await deliveryRow(appPool, ORG_A, "delivery-dec_deg");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();
    stages = await stageStatuses(appPool, ORG_A, "delivery-dec_deg");
    expect(stages.get("record_evidence")).toBe("succeeded");
    expect(await eventTypesFor(appPool, ORG_A, "run_deg")).toContain("delivery.completed");
    // PROOF of no-re-run: the resume drive never re-invoked the already-succeeded deploy/demo
    // cluster runners (they belong to durably-succeeded stages).
    expect(second.deploy.calls).toEqual([]);
    expect(second.demo.calls).toEqual([]);
  });

  it("cross-org isolation: driving org A never touches org B's delivery", async () => {
    const { driver } = makeDriver();
    // org A (idempotent — already completed)
    await driver.check("run_ok");

    const bRow = await deliveryRow(appPool, ORG_B, "delivery-dec_b");
    // untouched
    expect(bRow?.status).toBe("pending");
    expect(bRow?.completed_at).toBeNull();
    const bStages = await stageStatuses(appPool, ORG_B, "delivery-dec_b");
    // no stage attempts ever created for org B
    expect(bStages.size).toBe(0);
  });
});
