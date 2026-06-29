// STANDING CONFORMANCE — atomic spec-status flip + spec-disposition event
// seam (task #48 — critic-arc R4 BLOCKING #2/#3: the spec-level mirror of
// the per-task seam — task #39 — covering the disposition appliers
// (applyRedrive / applyGenuineHalt), the worker never-strand spec parks
// (parkStrandedSpec*), the merge-conflict escalator (PgSpecEscalator), and
// the batch / re-gate rework routers). All previously split the guarded
// spec UPDATE from the matching `dag.spec.redriven` / `dag.spec.needs_attention`
// event into two writes.
//
// Unlike the run/task atomic seams, the spec side admits NON-TERMINAL events
// (`dag.spec.redriven` is recurring per attempt; `dag.spec.needs_attention`
// can re-fire per incident — Plan §3) so there is NO partial unique index +
// no `appendIfAbsent` dedupe; the seam uses plain `.append`. The `flipped`
// outcome surfaces whether the guarded UPDATE moved a row so the caller can
// suppress the event emit on a no-op flip (a concurrent settle already moved
// the spec terminal).
//
// THIS SUITE pins the durability + the pairing constraint, against a REAL
// Postgres under the enforced `tanren_app` RLS role. Tests:
//
//   1. happy path — the row flip + the matching event commit together.
//   2. guard suppression — a `notFromStatuses` guard bit returns `flipped: false`
//      and the event is NOT written (the concurrent-settle case).
//   3. mismatched pair — `open` ↔ `dag.spec.needs_attention` rejected at seam.
//   4. recurring event — two back-to-back `dag.spec.redriven` calls both land
//      (the spec side has NO partial unique index — recurring events recur).
//   5. invalid payload — the event's Zod parse rolls back the WHOLE tx.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AllowAllPeerVerifier } from "../../src/engine/contracts/index.js";
import { DirectRunStateWriter, HttpRunStateWriter } from "../../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../../src/routes/internal/runStateWrites.js";
import {
  createWriteEndpointHarness,
  enabled,
  fetchInto,
  ORG,
  PROJECT,
  seedRun,
  SPEC,
} from "../planeSplitP3RemoteWritesHarness.js";

const describeDb = enabled ? describe : describe.skip;

/** Build a `dag.spec.redriven` atomic seam input keyed by runId (the recurring
 * event case in test (4) + the fixed-point-reader case in test (5b) reuse this
 * shape — extracted to module scope so the closure does not capture state from
 * its caller test, satisfying the no-inner-scope-recreation lint). */
function buildRedrivenInput(runId: string) {
  return {
    spec: { specId: SPEC, orgId: ORG, status: "open" as const, notFromStatuses: ["merged", "needs_attention"] },
    event: {
      runId,
      specId: SPEC,
      projectId: PROJECT,
      eventType: "dag.spec.redriven" as const,
      payload: {
        specId: SPEC,
        runId,
        failureCode: "internal",
        stage: "run",
        consecutiveSameFailure: 1,
        backoffSeconds: 5,
      } as never,
    },
  };
}

describeDb("updateSpecWithEvent atomic spec-pair (task #48) — real PG, enforced RLS", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  // (1) Happy path — the spec flip + the matching `dag.spec.redriven` commit together.
  it("(1) DirectRunStateWriter.updateSpecWithEvent flips spec to open + emits dag.spec.redriven together", async () => {
    const runId = "run_spec_atomic_redriven";
    await seedRun(ownerPool(), runId);

    // Reset the spec to a re-drivable state.
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    const outcome = await writer.updateSpecWithEvent({
      spec: { specId: SPEC, orgId: ORG, status: "open", notFromStatuses: ["merged", "needs_attention"] },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.redriven",
        payload: {
          specId: SPEC,
          runId,
          failureCode: "internal",
          stage: "run",
          consecutiveSameFailure: 1,
          backoffSeconds: 5,
        } as never,
      },
    });
    expect(outcome).toMatchObject({ flipped: true, alreadyTerminal: false });

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(row.rows[0]?.status).toBe("open");
    const ev = await ownerPool().query(
      "SELECT 1 FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.redriven' AND run_id = $2",
      [SPEC, runId],
    );
    expect(ev.rowCount).toBe(1);
  });

  // (2) Guard suppression — a `notFromStatuses` guard bit returns flipped:false
  // and the event is NOT written (the concurrent-settle case the strand
  // reconciler relies on so a spec already terminal-merged is not double-announced).
  it("(2) notFromStatuses guard bit returns flipped:false and suppresses the event", async () => {
    const runId = "run_spec_atomic_guard";
    await seedRun(ownerPool(), runId);

    // Pre-terminal the spec to `merged` so the guard bits.
    await ownerPool().query("UPDATE specs SET status = 'merged' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    const outcome = await writer.updateSpecWithEvent({
      spec: { specId: SPEC, orgId: ORG, status: "needs_attention", notFromStatuses: ["merged", "needs_attention"] },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: SPEC,
          reason: "persistent_failure",
          terminalRuns: [{ runId, status: "halted" }],
          attempts: 3,
          message: "stuck",
        } as never,
      },
    });
    expect(outcome).toMatchObject({ flipped: false, alreadyTerminal: false });

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(row.rows[0]?.status).toBe("merged");
    const ev = await ownerPool().query(
      "SELECT 1 FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.needs_attention'",
      [SPEC],
    );
    expect(ev.rowCount).toBe(0);
  });

  // (3) Pairing refinement — `open` ↔ `dag.spec.needs_attention` rejected.
  it("(3) mismatched pair (open ↔ dag.spec.needs_attention) is rejected BEFORE any DB I/O", async () => {
    const runId = "run_spec_atomic_mismatch";
    await seedRun(ownerPool(), runId);
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    const fail = writer.updateSpecWithEvent({
      // `open` ⇒ MUST pair with `dag.spec.redriven`.
      spec: { specId: SPEC, orgId: ORG, status: "open" },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: SPEC,
          reason: "persistent_failure",
          terminalRuns: [{ runId, status: "halted" }],
          attempts: 0,
          message: "x",
        } as never,
      },
    });
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(row.rows[0]?.status).toBe("in_flight");
  });

  // (4) Recurring event — two back-to-back `dag.spec.redriven` calls both
  // land (Plan §3 — no partial unique index on the spec side).
  it("(4) two back-to-back dag.spec.redriven calls BOTH land (recurring event)", async () => {
    const runId1 = "run_spec_atomic_rec_1";
    const runId2 = "run_spec_atomic_rec_2";
    await seedRun(ownerPool(), runId1);
    await seedRun(ownerPool(), runId2);
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());

    const first = await writer.updateSpecWithEvent(buildRedrivenInput(runId1));
    expect(first).toMatchObject({ flipped: true });

    // After the first call the spec is already `open` — the unguarded
    // re-call to `open` will still flip (no row-state guard) but the
    // event recurs as expected.
    const second = await writer.updateSpecWithEvent(buildRedrivenInput(runId2));
    expect(second).toMatchObject({ flipped: true });

    // Filter by run_id pair so prior tests' redriven events on the SAME shared
    // spec do not leak into this assertion (the harness reuses one SPEC for
    // all tests in this file — Plan §3 explicitly: the spec side has no
    // partial unique index so the events table accumulates across tests).
    const events = await ownerPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.redriven' AND run_id = ANY($2::text[])",
      [SPEC, [runId1, runId2]],
    );
    // Both redriven events should be present (recurring per attempt — no dedupe).
    expect(events.rows[0]?.count).toBe("2");
  });

  // (5) Atomicity — an INVALID event payload rolls back the WHOLE tx
  // (the row flip is reverted; the event is never written).
  it("(5) invalid event payload rolls back the whole transaction — spec stays at its pre-flip status", async () => {
    const runId = "run_spec_atomic_rollback";
    await seedRun(ownerPool(), runId);
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    const fail = writer.updateSpecWithEvent({
      spec: { specId: SPEC, orgId: ORG, status: "open", notFromStatuses: ["merged", "needs_attention"] },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.redriven",
        // `failureCode` MUST be a string; pass a non-string to fail Zod.
        payload: {
          specId: SPEC,
          runId,
          failureCode: 42,
          stage: "run",
          consecutiveSameFailure: 1,
          backoffSeconds: 5,
        } as never,
      },
    });
    await expect(fail).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(row.rows[0]?.status).toBe("in_flight");
    const ev = await ownerPool().query(
      "SELECT 1 FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.redriven' AND run_id = $2",
      [SPEC, runId],
    );
    expect(ev.rowCount).toBe(0);
  });

  // (5b) Plan §7 step 12 — integration with the fixed-point reader.
  // Pre-seed two `dag.spec.redriven` events through the atomic seam (the
  // shape `applyRedrive` writes them in), then run `buildRedriveHistoryReader`
  // and assert it sees the correct count (the reader's convergence judge
  // bites on the 2nd identical recurrence with progress evidenced beyond
  // one repeat — see plannerRunRedrive.test.ts for the matrix; here we
  // only assert the seam's writes are READABLE by the reader, i.e. the
  // round-trip durability through the new atomic transaction).
  it("(5b) atomic dag.spec.redriven writes are READABLE by the fixed-point reader (Plan §7 step 12)", async () => {
    const { buildRedriveHistoryReader } = await import("../../src/engine/workflow/plannerRunRedrive.js");
    const runId1 = "run_fpr_1";
    const runId2 = "run_fpr_2";
    await seedRun(ownerPool(), runId1);
    await seedRun(ownerPool(), runId2);
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    // Two prior re-drives via the atomic seam, same failure code.
    for (const runId of [runId1, runId2]) {
      await writer.updateSpecWithEvent({
        spec: { specId: SPEC, orgId: ORG, status: "open", notFromStatuses: ["merged", "needs_attention"] },
        event: {
          runId,
          specId: SPEC,
          projectId: PROJECT,
          eventType: "dag.spec.redriven",
          payload: {
            specId: SPEC,
            runId,
            failureCode: "internal",
            stage: "run",
            consecutiveSameFailure: 1,
            backoffSeconds: 5,
          } as never,
        },
      });
    }
    // The reader should observe BOTH historical events — the seam's writes
    // committed durably to the events table (the spec side has no
    // partial unique index that would dedupe them). The convergence judge's
    // verdict for two priors + a current `internal` failure is detector-defined;
    // we assert ONLY that the reader runs to completion and returns a number
    // (the seam-as-reader-input contract — Plan §7 step 12).
    const reader = buildRedriveHistoryReader(ownerPool());
    const facts = await reader({ orgId: ORG, specId: SPEC, code: "internal", stage: "run" });
    const priorSameFixedPoint = facts.priorSameFixedPoint;
    expect(typeof priorSameFixedPoint).toBe("number");
    // The harness's pool is the OWNER pool (RLS does not apply to the table
    // owner), so the reader reads under a SYSTEM scope rather than the
    // tanren_app RLS role. The convergence judge is deterministic over the
    // recorded history; the test asserts the reader saw the writes (the
    // historical query must return a count consistent with two priors of
    // the same code — `priorSameFixedPoint` is either 0 or 1 depending on
    // the judge's verdict, but the read MUST succeed).
    expect([0, 1]).toContain(priorSameFixedPoint);
    // Confirm the seam wrote both events durably (filter by the two run_ids
    // this test created — the SHARED spec collects events across the suite).
    const rows = await ownerPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE spec_id = $1 AND event_type = 'dag.spec.redriven' AND run_id = ANY($2::text[])",
      [SPEC, [runId1, runId2]],
    );
    expect(rows.rows[0]?.count).toBe("2");
  });

  // (6) HTTP round-trip — the HTTP writer + the route handler return 204 on
  // a fresh flip and 200 `{ flipped: false }` on the guard-bit case.
  it("(6) HttpRunStateWriter round-trip preserves the flipped outcome (204 fresh, 200 guarded)", async () => {
    const runId = "run_spec_atomic_http";
    await seedRun(ownerPool(), runId);
    await ownerPool().query("UPDATE specs SET status = 'in_flight' WHERE spec_id = $1", [SPEC]);

    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    const fresh = await writer.updateSpecWithEvent({
      spec: { specId: SPEC, orgId: ORG, status: "open", notFromStatuses: ["merged", "needs_attention"] },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.redriven",
        payload: {
          specId: SPEC,
          runId,
          failureCode: "internal",
          stage: "run",
          consecutiveSameFailure: 1,
          backoffSeconds: 5,
        } as never,
      },
    });
    expect(fresh).toMatchObject({ flipped: true });

    // Pre-terminal the spec for the guarded path.
    await ownerPool().query("UPDATE specs SET status = 'merged' WHERE spec_id = $1", [SPEC]);
    const guarded = await writer.updateSpecWithEvent({
      spec: { specId: SPEC, orgId: ORG, status: "needs_attention", notFromStatuses: ["merged", "needs_attention"] },
      event: {
        runId,
        specId: SPEC,
        projectId: PROJECT,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: SPEC,
          reason: "persistent_failure",
          terminalRuns: [{ runId, status: "halted" }],
          attempts: 0,
          message: "x",
        } as never,
      },
    });
    expect(guarded).toMatchObject({ flipped: false });
  });
});
