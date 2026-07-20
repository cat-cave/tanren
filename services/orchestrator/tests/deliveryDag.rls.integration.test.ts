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

import { migrate, resetSystemPool, runWithJobOrgId, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orgScopingPool } from "../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { PgDeployTriggerGate } from "../src/engine/postMerge/deployTriggerGate.js";
import { DeliveryDagDriver } from "../src/engine/postMerge/delivery/deliveryDagDriver.js";
import { contentAddressedEvidenceSigner } from "../src/engine/postMerge/delivery/deliveryEvidence.js";
import { DeliveryRunStore } from "../src/engine/postMerge/delivery/deliveryRunStore.js";
import { PgDeliverySignals } from "../src/engine/postMerge/delivery/deliverySignals.js";
import {
  deliveryEventTypesFor,
  deliveryRow,
  recordingRunner,
  seedDeliveryEvent,
  seedMergedRun,
  seedOrg,
  stageStatuses,
} from "./helpers/deliveryDagRlsSeed.js";

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
      demoGate: new PgDeployTriggerGate(appPool, "delivery.demo"),
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
    // (4) fence: concurrency + evidence-gate proofs (driven via the store directly).
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_fence",
      run: "run_fence",
      spec: "spec_fence",
      decision: "dec_fence",
      node: "node_fence",
      sha: "e".repeat(40),
      deliveryId: "delivery-dec_fence",
    });
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_gate",
      run: "run_gate",
      spec: "spec_gate",
      decision: "dec_gate",
      node: "node_gate",
      sha: "f".repeat(40),
      deliveryId: "delivery-dec_gate",
    });
    // (5a) demo RESUME (deadlock fix): a prior `stimulate` attempt but NO fire-intent marker
    // ⇒ the demo never fired ⇒ re-entry must FIRE and COMPLETE (not stick degraded).
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_demo",
      run: "run_demo",
      spec: "spec_demo",
      decision: "dec_demo",
      node: "node_demo",
      sha: "1".repeat(40),
      deliveryId: "delivery-dec_demo",
    });
    await ownerPool.query(
      `INSERT INTO delivery_stage_attempts (org_id, id, delivery_run_id, stage, ordinal, attempt, status, started_at)
       VALUES ($1, $2, $3, 'stimulate', 6, 1, 'running', now())`,
      [ORG_A, "delivery-dec_demo:stimulate:1", "delivery-dec_demo"],
    );
    // (5b) demo NO-DOUBLE-FIRE: the durable fire-INTENT marker is present with NO terminal
    // demo event ⇒ a possible mid-crash fire ⇒ re-entry must DEGRADE (never re-fire).
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_demo2",
      run: "run_demo2",
      spec: "spec_demo2",
      decision: "dec_demo2",
      node: "node_demo2",
      sha: "2".repeat(40),
      deliveryId: "delivery-dec_demo2",
    });
    const demo2 = { org: ORG_A, run: "run_demo2", spec: "spec_demo2", project: "proj_demo2" };
    await seedDeliveryEvent(ownerPool, demo2, "delivery.demo_stimulus_started", {
      deliveryRunId: "delivery-dec_demo2",
      mergeSha: "2".repeat(40),
    });
    // (5c) demo PRE-DISPATCH FAILURE re-fire: a prior drive recorded a fire-intent then ABORTED
    // the intent (the effect proved not-dispatched) ⇒ NOT live ⇒ re-entry must FIRE and COMPLETE.
    await seedMergedRun(ownerPool, {
      org: ORG_A,
      project: "proj_demo3",
      run: "run_demo3",
      spec: "spec_demo3",
      decision: "dec_demo3",
      node: "node_demo3",
      sha: "3".repeat(40),
      deliveryId: "delivery-dec_demo3",
    });
    const demo3 = { org: ORG_A, run: "run_demo3", spec: "spec_demo3", project: "proj_demo3" };
    await seedDeliveryEvent(ownerPool, demo3, "delivery.demo_stimulus_started", {
      deliveryRunId: "delivery-dec_demo3",
      mergeSha: "3".repeat(40),
    });
    await seedDeliveryEvent(ownerPool, demo3, "delivery.demo_stimulus_aborted", {
      deliveryRunId: "delivery-dec_demo3",
      reason: "no_terminal_after_run",
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

    expect(await deliveryEventTypesFor(appPool, ORG_A, "run_ok")).toContain("delivery.completed");
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
    const evTypes1 = await deliveryEventTypesFor(appPool, ORG_A, "run_deg");
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
    expect(await deliveryEventTypesFor(appPool, ORG_A, "run_deg")).toContain("delivery.completed");
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

  // Finding 1: the claim is a REAL fence — a superseded (stale) owner's writes are no-ops,
  // and a completed run can never be flipped to degraded by a stale writer.
  it("fence: a superseded owner's settle is a no-op; only the live owner settles", async () => {
    const store = new DeliveryRunStore(appPool);
    const id = "delivery-dec_fence";
    const stale = await store.claim(ORG_A, "proj_fence", "e".repeat(40));
    // supersedes the stale token
    const live = await store.claim(ORG_A, "proj_fence", "e".repeat(40));
    expect(stale).toBeDefined();
    expect(live).toBeDefined();
    if (stale === undefined || live === undefined) throw new Error("claim failed");
    expect(stale.token).not.toBe(live.token);

    // The stale owner's fence renew + terminal writes are ALL rejected (0 rows).
    expect(await store.renewClaim(ORG_A, id, stale.token)).toBe(false);
    expect(await store.markDegraded(ORG_A, id, stale.token, "stale_degrade")).toBe(false);
    expect(await store.markNeedsAttention(ORG_A, id, stale.token, "stale_attn")).toBe(false);
    // The live owner still owns it.
    expect(await store.renewClaim(ORG_A, id, live.token)).toBe(true);
    // The live owner degrades it (terminal for this pass).
    expect(await store.markDegraded(ORG_A, id, live.token, "live_degrade")).toBe(true);
    // A stale writer cannot flip the settled run afterward (status is no longer 'running').
    expect(await store.markNeedsAttention(ORG_A, id, stale.token, "stale_flip")).toBe(false);
    const row = await deliveryRow(appPool, ORG_A, id);
    expect(row?.status).toBe("degraded");
  });

  // Finding 3: markCompleted refuses without a durable signed `delivery.completed` evidence row.
  it("fence + evidence gate: markCompleted refuses until the signed evidence row exists", async () => {
    const store = new DeliveryRunStore(appPool);
    const id = "delivery-dec_gate";
    const claimed = await store.claim(ORG_A, "proj_gate", "f".repeat(40));
    expect(claimed).toBeDefined();
    if (claimed === undefined) throw new Error("claim failed");

    // No signed evidence yet → the fenced, evidence-gated CAS returns false.
    expect(await store.markCompleted(ORG_A, id, claimed.token, "run_gate", "proj_gate")).toBe(false);
    expect((await deliveryRow(appPool, ORG_A, id))?.status).toBe("running");

    // Append the durable signed evidence, then completion is permitted.
    await runWithJobOrgId(ORG_A, () =>
      new PgEventStore(orgScopingPool(ownerPool)).append({
        runId: "run_gate",
        specId: "spec_gate",
        projectId: "proj_gate",
        orgId: ORG_A,
        eventType: "delivery.completed",
        payload: {
          deliveryRunId: id,
          mergeSha: "f".repeat(40),
          stagesConfirmed: ["observe"],
          observedEffect: "none",
          evidenceDigest: `sha256:${"0".repeat(64)}`,
          signature: `sha256:${"0".repeat(64)}`,
        },
      }),
    );
    expect(await store.markCompleted(ORG_A, id, claimed.token, "run_gate", "proj_gate")).toBe(true);
    expect((await deliveryRow(appPool, ORG_A, id))?.status).toBe("completed");
  });

  // Finding 1 (deadlock fix): a re-entered demo with a prior ATTEMPT but NO fire-intent marker
  // never fired — it must FIRE and the delivery must COMPLETE (not stick degraded forever).
  it("demo resume: a prior stimulate attempt with NO intent marker FIRES and completes", async () => {
    const { driver, demo } = makeDriver();
    await driver.check("run_demo");

    const row = await deliveryRow(appPool, ORG_A, "delivery-dec_demo");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();
    const evTypes = await deliveryEventTypesFor(appPool, ORG_A, "run_demo");
    expect(evTypes).toContain("delivery.completed");
    expect(evTypes).not.toContain("delivery.degraded");
    // The demo runner WAS invoked (the never-fired demo resumed and ran) — no permanent degrade.
    expect(demo.calls).toEqual(["run_demo"]);
  });

  // Finding 1: a demo re-entered with the durable fire-INTENT marker present but NO terminal
  // demo event does NOT re-fire the possibly-committed effect — it degrades fail-closed.
  it("demo no-double-fire: an intent marker without a terminal degrades and does NOT re-fire", async () => {
    const { driver, demo } = makeDriver();
    await driver.check("run_demo2");

    const row = await deliveryRow(appPool, ORG_A, "delivery-dec_demo2");
    expect(row?.status).toBe("degraded");
    expect(row?.completed_at).toBeNull();
    const evTypes = await deliveryEventTypesFor(appPool, ORG_A, "run_demo2");
    expect(evTypes).toContain("delivery.degraded");
    expect(evTypes).not.toContain("delivery.completed");
    // The demo runner was NEVER invoked — the committed-maybe prior effect is not re-fired.
    expect(demo.calls).toEqual([]);
  });

  // Finding HIGH: a prior fire-intent that was ABORTED (pre-dispatch failure proved not-dispatched)
  // is NOT live ⇒ the demo RE-FIRES and the delivery COMPLETES (no permanent degrade).
  it("demo pre-dispatch failure: a started+aborted intent RE-FIRES and completes", async () => {
    const { driver, demo } = makeDriver();
    await driver.check("run_demo3");

    const row = await deliveryRow(appPool, ORG_A, "delivery-dec_demo3");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();
    const evTypes = await deliveryEventTypesFor(appPool, ORG_A, "run_demo3");
    expect(evTypes).toContain("delivery.completed");
    expect(evTypes).not.toContain("delivery.degraded");
    // The demo runner WAS re-invoked (the aborted intent did not strand it).
    expect(demo.calls).toEqual(["run_demo3"]);
  });
});
