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
import {
  DirectIntegrationStateWriter,
  type ClaimIntegrationReconciliationInput,
  type ClaimedIntegrationReconciliation,
  type CompleteIntegrationReconciliationInput,
  type HeartbeatIntegrationReconciliationInput,
  type IntegrationStateWriter,
  type MarkIntegrationReconciliationStateUnknownInput,
} from "../src/engine/contracts/integrationStateWriter.js";
import { ReconciliationSagaDriver } from "../src/engine/integrations/reconciliationSaga.js";
import type {
  ReconcileContext,
  ReconcileObservation,
  ReconcileProbe,
} from "../src/engine/integrations/reconcileProbe.js";
import {
  DIGEST,
  nodeStatus,
  recEvents,
  recFull,
  recStatus,
  seedBindingLineage,
  seedBoundReconciliation,
  seedCapabilityNode,
  seedOrg,
  seedProject,
  seedReconciliation,
  seedSnapshot,
  seedSnapshotForGeneration,
} from "./helpers/reconciliationSagaSeed.js";

/** Forces the production writer's completion predicate to observe an expired lease. */
class ExpiringCompleteWriter implements IntegrationStateWriter {
  constructor(
    private readonly writer: DirectIntegrationStateWriter,
    private readonly ownerPool: Pool,
  ) {}

  claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined> {
    return this.writer.claim(input);
  }

  heartbeat(input: HeartbeatIntegrationReconciliationInput): Promise<boolean> {
    return this.writer.heartbeat(input);
  }

  async complete(input: CompleteIntegrationReconciliationInput): Promise<boolean> {
    await this.ownerPool.query(
      "UPDATE integration_reconciliations SET claim_expires_at = now() - interval '1 second' WHERE org_id = $1 AND id = $2",
      [input.orgId, input.reconciliationId],
    );
    return this.writer.complete(input);
  }

  stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    return this.writer.stateUnknown(input);
  }

  stateUnknownAfterClaimLost(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    return this.writer.stateUnknownAfterClaimLost(input);
  }
}

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_reconcile_a";
const ORG_B = "org_reconcile_b";
// One project per test so a project-scoped sweep never leaks another test's rows.
const PROJECT_CONV = "project_reconcile_conv";
const PROJECT_UNK = "project_reconcile_unk";
const PROJECT_RESUME = "project_reconcile_resume";
const PROJECT_DRIFT = "project_reconcile_drift";
const PROJECT_PINNED = "project_reconcile_pinned";
const PROJECT_LOST = "project_reconcile_lost";
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
    // Convergence requires the observed hash to EXACTLY equal the desired fingerprint.
    await seedSnapshot(ownerPool, ORG_A, PROJECT_CONV, "requirement_conv", "snap_healthy", "healthy", DIGEST);

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

  it("NEGATIVE CONTROL: a healthy-but-DRIFTED snapshot (observed ≠ desired) does NOT advance the node", async () => {
    // The layer-2 fail-open: a health flag is not desired-state confirmation. A healthy
    // observation whose hash differs from the desired fingerprint must reconcile as
    // progress (drift), NEVER fixed_point/ready.
    await seedProject(ownerPool, ORG_A, PROJECT_DRIFT, "requirement_drift");
    await seedCapabilityNode(ownerPool, ORG_A, PROJECT_DRIFT, "requirement_drift", "capnode_drift");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_DRIFT, "requirement_drift", "rec_drift");
    await seedSnapshot(
      ownerPool,
      ORG_A,
      PROJECT_DRIFT,
      "requirement_drift",
      "snap_drift",
      "healthy",
      `sha256:${"9".repeat(64)}`,
    );

    const saga = new ReconciliationSagaDriver(appPool, { leaseMs: 30_000, retrySpacingMs: 1_000 });
    const summary = await saga.driveForOrg(ORG_A, PROJECT_DRIFT);
    expect(summary.fixedPoint).toBe(0);
    expect(summary.readied).toBe(0);
    expect(summary.retryScheduled).toBe(1);

    const rec = await recStatus(ownerPool, ORG_A, "rec_drift");
    expect(rec.status).toBe("retry_scheduled");
    expect(await nodeStatus(ownerPool, ORG_A, "capnode_drift")).toBe("enqueued");
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

  it("NEGATIVE CONTROL: a healthy snapshot for a PRIOR binding generation does NOT confirm the pinned one", async () => {
    // The reconciliation pins binding generation 2; a healthy+matching snapshot exists
    // only for generation 1. Scoped to the pinned coordinate there is NO observation for
    // generation 2 → state_unknown (fail-closed), never "use the newest for the requirement".
    await seedProject(ownerPool, ORG_A, PROJECT_PINNED, "requirement_pinned");
    await seedCapabilityNode(ownerPool, ORG_A, PROJECT_PINNED, "requirement_pinned", "capnode_pinned");
    const bindingId = await seedBindingLineage(ownerPool, ORG_A, PROJECT_PINNED, "requirement_pinned");
    // A healthy+matching observation, but only for generation 1 (the stale generation).
    await seedSnapshotForGeneration(
      ownerPool,
      ORG_A,
      PROJECT_PINNED,
      "requirement_pinned",
      "snap_gen1",
      bindingId,
      1,
      DIGEST,
    );
    // The reconciliation under drive pins generation 2 (no snapshot exists for it).
    await seedBoundReconciliation(ownerPool, ORG_A, PROJECT_PINNED, "requirement_pinned", "rec_pinned", bindingId, 2);

    const saga = new ReconciliationSagaDriver(appPool, { leaseMs: 30_000, retrySpacingMs: 1_000 });
    const summary = await saga.driveForOrg(ORG_A, PROJECT_PINNED);
    expect(summary.stateUnknown).toBe(1);
    expect(summary.fixedPoint).toBe(0);
    expect(summary.readied).toBe(0);

    const rec = await recStatus(ownerPool, ORG_A, "rec_pinned");
    expect(rec.status).toBe("state_unknown");
    expect(rec.failure_classification).toBe("no_observation_for_pinned_generation");
    expect(await nodeStatus(ownerPool, ORG_A, "capnode_pinned")).toBe("enqueued");
  });

  it("NEGATIVE CONTROL: a lost claim mid-settle does NOT report terminal success (records state_unknown)", async () => {
    // A converged observation would normally fixed_point + ready the node. But the lease
    // is expired just before complete(), so the claim-fenced write no-ops. The settle
    // must fail-closed to state_unknown, NOT a terminal success, and NOT advance the node.
    await seedProject(ownerPool, ORG_A, PROJECT_LOST, "requirement_lost");
    await seedCapabilityNode(ownerPool, ORG_A, PROJECT_LOST, "requirement_lost", "capnode_lost");
    await seedReconciliation(ownerPool, ORG_A, PROJECT_LOST, "requirement_lost", "rec_lost");
    await seedSnapshot(ownerPool, ORG_A, PROJECT_LOST, "requirement_lost", "snap_lost", "healthy", DIGEST);

    const writer = new ExpiringCompleteWriter(new DirectIntegrationStateWriter(appPool), ownerPool);
    const saga = new ReconciliationSagaDriver(appPool, { stateWriter: writer, leaseMs: 30_000, retrySpacingMs: 1_000 });
    const summary = await saga.driveForOrg(ORG_A, PROJECT_LOST);
    expect(summary.fixedPoint).toBe(0);
    expect(summary.stateUnknown).toBe(1);
    expect(summary.readied).toBe(0);

    const rec = await recStatus(ownerPool, ORG_A, "rec_lost");
    expect(rec.status).toBe("state_unknown");
    expect(await nodeStatus(ownerPool, ORG_A, "capnode_lost")).toBe("enqueued");
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
