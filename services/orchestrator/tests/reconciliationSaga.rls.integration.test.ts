// in-11 — REAL-Postgres proof of the durable reconciliation saga. The saga runs as
// the non-superuser tenant role (`tanren_app`) through the real control-plane writer
// (in-4) + the pg claim source + the recorded-snapshot production probe, over the
// real `0000→0043` migration chain. It proves: a confirmable reconcile advances
// (fixed_point) and readies its capability node; an unconfirmable external state
// fail-closes to state_unknown (durable, NOT advanced); a crashed mid-flight saga
// resumes from its durable history; progress-based retry is unbounded (no cap); and
// an org-A sweep never touches an org-B reconciliation.

import { migrate, resetSystemPool, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReconciliationSagaDriver } from "../src/engine/integrations/reconciliationSaga.js";
import type {
  ReconcileContext,
  ReconcileObservation,
  ReconcileProbe,
} from "../src/engine/integrations/reconcileProbe.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OBSERVED = `sha256:${"b".repeat(64)}`;

const ORG_A = "org_reconcile_a";
const ORG_B = "org_reconcile_b";
// One project per test so a project-scoped sweep never leaks another test's rows.
const PROJECT_CONV = "project_reconcile_conv";
const PROJECT_UNK = "project_reconcile_unk";
const PROJECT_RESUME = "project_reconcile_resume";
const PROJECT_B = "project_reconcile_b";

function dbName(): string {
  return `tanren_reconcile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

/** A scripted probe: returns the next observation each call (last one repeats). */
class ScriptedProbe implements ReconcileProbe {
  private index = 0;
  constructor(private readonly script: readonly ReconcileObservation[]) {}
  observe(_context: ReconcileContext): Promise<ReconcileObservation> {
    const step = this.script[Math.min(this.index, this.script.length - 1)]!;
    this.index += 1;
    return Promise.resolve(step);
  }
}

describeDb("ReconciliationSagaDriver — real-Postgres durable saga", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    await seedOrg(ownerPool, ORG_A);
    await seedOrg(ownerPool, ORG_B);
    await seedProject(ownerPool, ORG_A, PROJECT_CONV, "requirement_conv");
    await seedProject(ownerPool, ORG_A, PROJECT_UNK, "requirement_unk");
    await seedProject(ownerPool, ORG_A, PROJECT_RESUME, "requirement_resume");
    await seedProject(ownerPool, ORG_B, PROJECT_B, "requirement_b");
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

  it("advances a confirmable reconcile to fixed_point and readies its capability node", async () => {
    await seedCapabilityNode(ownerPool, ORG_A, PROJECT_CONV, "requirement_conv", "capnode_conv");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_CONV, "requirement_conv", "rec_converged");
    await seedSnapshot(ownerPool, ORG_A, PROJECT_CONV, "requirement_conv", "snap_healthy", "healthy");

    const saga = new ReconciliationSagaDriver(appPool, { leaseMs: 30_000, retrySpacingMs: 1_000 });
    const summary = await saga.drive(PROJECT_CONV);
    expect(summary.fixedPoint).toBe(1);
    expect(summary.readied).toBe(1);

    const rec = await recStatus(ownerPool, ORG_A, "rec_converged");
    expect(rec.status).toBe("fixed_point");
    expect(rec.progress_signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const node = await nodeStatus(ownerPool, ORG_A, "capnode_conv");
    expect(node).toBe("ready");
    expect(await recEvents(ownerPool, ORG_A, "rec_converged")).toEqual([
      "integration.reconcile.started",
      "integration.reconcile.fixed_point",
    ]);
  });

  it("fail-closes an unconfirmable external state to state_unknown WITHOUT advancing", async () => {
    await seedCapabilityNode(ownerPool, ORG_A, PROJECT_UNK, "requirement_unk", "capnode_unk");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_UNK, "requirement_unk", "rec_unknown");
    await seedSnapshot(ownerPool, ORG_A, PROJECT_UNK, "requirement_unk", "snap_unknown", "unknown");

    const saga = new ReconciliationSagaDriver(appPool, { leaseMs: 30_000, retrySpacingMs: 1_000 });
    await saga.driveForOrg(ORG_A, PROJECT_UNK);

    const rec = await recStatus(ownerPool, ORG_A, "rec_unknown");
    expect(rec.status).toBe("state_unknown");
    expect(rec.failure_classification).toBe("provider_observation_unknown");
    // NOT advanced: the capability node stays enqueued (the halt is explicit, not silent).
    expect(await nodeStatus(ownerPool, ORG_A, "capnode_unk")).toBe("enqueued");
    expect(await recEvents(ownerPool, ORG_A, "rec_unknown")).toEqual([
      "integration.reconcile.started",
      "integration.reconcile.state_unknown",
    ]);
  });

  it("resumes a crashed mid-flight reconciliation from its durable history (progress retry, no cap)", async () => {
    // A worker persisted progress [sig-1] then crashed holding an expired claim.
    await ownerPool.query(
      `INSERT INTO integration_reconciliations
         (org_id, id, project_id, requirement_id, phase, idempotency_key, request_fingerprint,
          status, attempt, claim_owner, claim_expires_at, compensation_state)
       VALUES ($1, 'rec_resume', $2, 'requirement_resume', 'discover', 'rec_resume', $3,
               'claimed', 3, 'dead-worker', now() - interval '1 minute',
               '{"attemptHistory":[{"failureSignature":"progressing","workSignature":"sig-1"}]}'::jsonb)`,
      [ORG_A, PROJECT_RESUME, `sha256:${"c".repeat(64)}`],
    );
    // A distinct new observation each walk = genuine forward motion; unbounded retries.
    const probe = new ScriptedProbe(
      Array.from(
        { length: 6 },
        (_v, i) => ({ kind: "progressing", signal: `sig-${i + 2}`, observedState: { i } }) as const,
      ),
    );
    const saga = new ReconciliationSagaDriver(appPool, { probe, leaseMs: 30_000, retrySpacingMs: 1_000 });

    const first = await saga.driveForOrg(ORG_A, PROJECT_RESUME);
    expect(first.retryScheduled).toBe(1);
    let rec = await recFull(ownerPool, ORG_A, "rec_resume");
    expect(rec.status).toBe("retry_scheduled");
    // Re-claimed the expired lease and advanced.
    expect(rec.attempt).toBe(4);
    expect(rec.compensation_state.attemptHistory).toEqual([
      { failureSignature: "progressing", workSignature: "sig-1" },
      { failureSignature: "progressing", workSignature: "sig-2" },
    ]);

    // Several more walks, each still progressing → still retrying, never escalates. The
    // retry SPACING (progress-spaced backoff) is real, so elapse it deterministically —
    // the point under test is progress-based unbounded retry, not the wall-clock spacing.
    for (let walk = 0; walk < 4; walk += 1) {
      await ownerPool.query(
        "UPDATE integration_reconciliations SET retry_after = now() - interval '1 second' WHERE org_id = $1 AND id = 'rec_resume'",
        [ORG_A],
      );
      const summary = await saga.driveForOrg(ORG_A, PROJECT_RESUME);
      expect(summary.retryScheduled).toBe(1);
      expect(summary.needsAttention).toBe(0);
    }
    rec = await recFull(ownerPool, ORG_A, "rec_resume");
    expect(rec.status).toBe("retry_scheduled");
    expect(rec.attempt).toBe(8);
  });

  it("does not let an org-A sweep address an org-B reconciliation", async () => {
    await seedReconciliation(ownerPool, ORG_B, PROJECT_B, "requirement_b", "rec_other_org");
    const saga = new ReconciliationSagaDriver(appPool, { leaseMs: 30_000, retrySpacingMs: 1_000 });
    // Sweeps org A only.
    await saga.driveForOrg(ORG_A, PROJECT_CONV);
    const rec = await recStatus(ownerPool, ORG_B, "rec_other_org");
    // Untouched — a cross-org sweep never addresses org B's reconciliation.
    expect(rec.status).toBe("pending");
    expect(await recEvents(ownerPool, ORG_B, "rec_other_org")).toEqual([]);
  });
});

async function seedOrg(pool: Pool, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
}

async function seedProject(pool: Pool, orgId: string, projectId: string, requirementId: string): Promise<void> {
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/reconcile.git', $2)`,
    [projectId, orgId],
  );
  await pool.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, 'errors', 'product', 'outbound', '{}'::jsonb,
             'design_contract', $2, $4, 'policy-v1', 'release_required')`,
    [orgId, requirementId, projectId, DIGEST],
  );
}

async function seedCapabilityNode(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  nodeId: string,
  desiredHash: string = DIGEST,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_nodes
       (org_id, id, project_id, requirement_id, environment, desired_state_hash, status, priority, generation)
     VALUES ($1, $2, $3, $4, 'test', $5, 'enqueued', 0, 1)`,
    [orgId, nodeId, projectId, requirementId, desiredHash],
  );
}

async function seedReconciliation(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  reconciliationId: string,
  fingerprint: string = DIGEST,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_reconciliations
       (org_id, id, project_id, requirement_id, phase, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'discover', $2, $5)`,
    [orgId, reconciliationId, projectId, requirementId, fingerprint],
  );
}

async function seedSnapshot(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  snapshotId: string,
  health: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_resource_snapshots
       (org_id, id, project_id, requirement_id, provider_kind, external_resource_id,
        observed_state_hash, sanitized_snapshot, health, last_seen_at)
     VALUES ($1, $2, $3, $4, 'sentry', $2, $5, '{}'::jsonb, $6, now())`,
    [orgId, snapshotId, projectId, requirementId, OBSERVED, health],
  );
}

async function recStatus(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<{ status: string; failure_classification: string | null; progress_signature: string | null }> {
  const r = await pool.query<{
    status: string;
    failure_classification: string | null;
    progress_signature: string | null;
  }>(
    "SELECT status, failure_classification, progress_signature FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
    [orgId, id],
  );
  return r.rows[0]!;
}

async function recFull(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<{ status: string; attempt: number; compensation_state: { attemptHistory: unknown[] } }> {
  const r = await pool.query<{ status: string; attempt: number; compensation_state: { attemptHistory: unknown[] } }>(
    "SELECT status, attempt, compensation_state FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
    [orgId, id],
  );
  return r.rows[0]!;
}

async function nodeStatus(pool: Pool, orgId: string, nodeId: string): Promise<string> {
  const r = await pool.query<{ status: string }>("SELECT status FROM capability_nodes WHERE org_id = $1 AND id = $2", [
    orgId,
    nodeId,
  ]);
  return r.rows[0]!.status;
}

async function recEvents(pool: Pool, orgId: string, reconciliationId: string): Promise<string[]> {
  const r = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE org_id = $1 AND payload ->> 'reconciliationId' = $2 ORDER BY id",
    [orgId, reconciliationId],
  );
  return r.rows.map((row) => row.event_type);
}
