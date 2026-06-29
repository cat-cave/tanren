// STANDING CONFORMANCE — audit finding #3: the WINDOW-PAUSE RESUME atomic
// seam (`resumePausedRunAtomic`). The prior shape ran TWO sequential atomic
// seams (`finalizeRunWithEvent` + `updateSpecWithEvent`) in SEPARATE
// transactions; a crash between them stranded `runs.status=halted` +
// `specs.status=in_flight` with no poll path able to recover it (the
// prober's `WHERE status='paused'` never re-matched, and the walker won't
// re-drive an `in_flight` spec). The fix lands ALL FOUR writes — the run
// finalize (`paused → halted` + `run.resumed`) AND the spec flip
// (`in_flight → open` + `dag.spec.redriven`) — in ONE org-scoped transaction.
//
// THIS SUITE pins both the durability + the atomicity contract against a
// REAL Postgres under the enforced `tanren_app` RLS role. Tests:
//
//   1. happy path — `resumePausedRunAtomic` lands ALL FOUR writes together
//      (one tx, both rows + both events visible at commit).
//   2. row guard — resume against a run NOT in `paused` matches no row;
//      `runFinalized: false` and NO event written; the spec is untouched.
//   3. invalid event payload — the spec-side event INSERT THROWS inside the
//      transaction → ROLLBACK → neither row flipped, neither event landed.
//   4. mismatched pair — `paused → halted` ↔ a non-`run.resumed` event is
//      rejected by `resumePausedRunPairSchema` BEFORE any DB I/O.
//   5. spec already terminal — `notFromStatuses` guard skips the spec flip
//      (the run still resumed, but the spec is past `in_flight` already).
//   6. HTTP endpoint — the route returns 200 with the full outcome JSON
//      (mirrors `/internal/finalize-run-with-event` discipline).
//   7. discriminator — the `dag.spec.redriven` event carries
//      `payload.source: "prober_resume"` (audit finding #13) so the
//      convergence history reader filters it out.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL, exactly like
// the planeSplitP3RemoteWrites cohort. Shares `planeSplitP3RemoteWritesHarness`
// for the throwaway DB lifecycle + tenant constants + the in-process mTLS shim.

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

const RESUMED_EVENT_PAYLOAD = {
  provider: "agent",
  slot: "primary",
  usedPercent: 0,
  pausedDurationSeconds: 60,
} as const;

const REDRIVEN_EVENT_PAYLOAD = {
  specId: SPEC,
  runId: "REPLACE-ME",
  failureCode: "usage_limit",
  stage: "agent",
  consecutiveSameFailure: 0,
  backoffSeconds: 0,
  source: "prober_resume",
} as const;

function buildInput(runId: string, overrides?: { specStatus?: string; redrivenEventType?: string }) {
  return {
    finalize: {
      runId,
      orgId: ORG,
      status: "halted" as const,
      outcome: "window_paused" as const,
      fromStatuses: ["paused"],
    },
    resumedEvent: {
      runId,
      specId: SPEC,
      projectId: PROJECT,
      eventType: "run.resumed" as const,
      payload: RESUMED_EVENT_PAYLOAD as never,
    },
    spec: {
      specId: SPEC,
      orgId: ORG,
      status: (overrides?.specStatus ?? "open") as "open",
      notFromStatuses: ["merged", "needs_attention"],
    },
    redrivenEvent: {
      runId,
      specId: SPEC,
      projectId: PROJECT,
      eventType: (overrides?.redrivenEventType ?? "dag.spec.redriven") as "dag.spec.redriven",
      payload: { ...REDRIVEN_EVENT_PAYLOAD, runId } as never,
    },
  };
}

describeDb("resumePausedRunAtomic — atomic 4-write pair (audit finding #3) — real PG, enforced RLS", () => {
  const harness = createWriteEndpointHarness();
  const ownerPool = () => harness.ownerPool();
  const runtimePool = () => harness.runtimePool();

  beforeAll(() => harness.setUp(), 60_000);
  afterAll(() => harness.tearDown(), 30_000);

  // (1) Happy path — ALL FOUR writes commit together.
  it("(1) DirectRunStateWriter.resumePausedRunAtomic lands run finalize + run.resumed AND spec flip + dag.spec.redriven", async () => {
    const runId = "run_resume_atomic_happy";
    await seedRun(ownerPool(), runId, "paused");

    const writer = new DirectRunStateWriter(runtimePool());
    const outcome = await writer.resumePausedRunAtomic(buildInput(runId));
    expect(outcome.runFinalized).toBe(true);
    expect(outcome.runEventAlreadyTerminal).toBe(false);
    expect(outcome.specFlipped).toBe(true);
    expect(outcome.specId).toBe(SPEC);
    expect(outcome.projectId).toBe(PROJECT);

    const row = await ownerPool().query<{ status: string; outcome: string | null }>(
      "SELECT status, outcome FROM runs WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]).toMatchObject({ status: "halted", outcome: "window_paused" });
    const spec = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(spec.rows[0]?.status).toBe("open");
    const events = await ownerPool().query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE run_id = $1 ORDER BY id ASC",
      [runId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["run.resumed", "dag.spec.redriven"]);
  });

  // (2) Row guard — finalize against a non-`paused` row matches no row.
  it("(2) row guard: resume against a non-paused run returns runFinalized:false and no events", async () => {
    const runId = "run_resume_atomic_guard";
    // Seed status is `running` — NOT paused, so the resume's `fromStatuses` guard rejects.
    await seedRun(ownerPool(), runId, "running");

    const writer = new DirectRunStateWriter(runtimePool());
    const outcome = await writer.resumePausedRunAtomic(buildInput(runId));
    expect(outcome.runFinalized).toBe(false);
    expect(outcome.specFlipped).toBe(false);

    const events = await ownerPool().query("SELECT 1 FROM events WHERE run_id = $1", [runId]);
    expect(events.rowCount).toBe(0);
    // The spec stays in_flight (the run never resumed, so the spec was untouched).
    const spec = await ownerPool().query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC]);
    expect(spec.rows[0]?.status).toBe("in_flight");
  });

  // (3) Atomicity — an INVALID spec-side event payload rolls back the WHOLE tx.
  it("(3) invalid spec-side event payload rolls back the whole transaction — neither flip lands, neither event lands", async () => {
    const runId = "run_resume_atomic_rollback";
    await seedRun(ownerPool(), runId, "paused");

    const writer = new DirectRunStateWriter(runtimePool());
    const input = buildInput(runId);
    // failureCode must be one of the enumerated codes; pass an invalid one to fail Zod parse.
    input.redrivenEvent.payload = { ...REDRIVEN_EVENT_PAYLOAD, runId, failureCode: "not_a_real_code" } as never;
    await expect(writer.resumePausedRunAtomic(input)).rejects.toBeInstanceOf(Error);

    // Neither row flipped, neither event landed.
    const row = await ownerPool().query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [runId]);
    expect(row.rows[0]?.status).toBe("paused");
    const events = await ownerPool().query("SELECT 1 FROM events WHERE run_id = $1", [runId]);
    expect(events.rowCount).toBe(0);
  });

  // (4) Pair-schema refinement — a non-`run.resumed` event type is rejected BEFORE any DB I/O.
  it("(4) mismatched pair (run finalize ↔ non-run.resumed event) is rejected BEFORE any DB I/O", async () => {
    const runId = "run_resume_atomic_pair_mismatch";
    await seedRun(ownerPool(), runId, "paused");

    const writer = new DirectRunStateWriter(runtimePool());
    const input = buildInput(runId);
    // Override the event type to something that isn't `run.resumed` — the
    // resumePausedRunPairSchema rejects this at the seam.
    (input.resumedEvent as { eventType: string }).eventType = "run.failed";
    await expect(writer.resumePausedRunAtomic(input)).rejects.toBeInstanceOf(Error);

    const row = await ownerPool().query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [runId]);
    expect(row.rows[0]?.status).toBe("paused");
  });

  // (5) Spec already terminal — the `notFromStatuses` guard skips the spec flip.
  it("(5) spec already merged/needs_attention: the run still resumes, the spec flip is skipped", async () => {
    const runId = "run_resume_atomic_spec_already_terminal";
    await seedRun(ownerPool(), runId, "paused");
    // Force the spec to a guarded state (operator-cancelled / settled).
    await ownerPool().query("UPDATE specs SET status = 'needs_attention' WHERE spec_id = $1", [SPEC]);

    const writer = new DirectRunStateWriter(runtimePool());
    const outcome = await writer.resumePausedRunAtomic(buildInput(runId));
    expect(outcome.runFinalized).toBe(true);
    expect(outcome.specFlipped).toBe(false);

    const events = await ownerPool().query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE run_id = $1 ORDER BY id ASC",
      [runId],
    );
    // The run.resumed landed (paired with the run finalize). The
    // dag.spec.redriven was suppressed because the spec flip was a no-op.
    expect(events.rows.map((r) => r.event_type)).toEqual(["run.resumed"]);
  });

  // (6) HTTP route shape — always 200 with the full outcome JSON.
  it("(6) HttpRunStateWriter: fresh resume returns 200 with the full outcome JSON", async () => {
    const runId = "run_resume_atomic_http";
    await seedRun(ownerPool(), runId, "paused");

    const app = createInternalRunStateWriteRoutes({ pool: runtimePool(), verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));
    const outcome = await writer.resumePausedRunAtomic(buildInput(runId));
    expect(outcome.runFinalized).toBe(true);
    expect(outcome.specFlipped).toBe(true);
    expect(outcome.specId).toBe(SPEC);

    const events = await ownerPool().query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM events WHERE run_id = $1",
      [runId],
    );
    expect(events.rows[0]?.count).toBe("2");
  });

  // (7) Audit finding #13 — the dag.spec.redriven payload carries source:prober_resume.
  it("(7) audit finding #13: the dag.spec.redriven event carries payload.source = 'prober_resume'", async () => {
    const runId = "run_resume_atomic_prober_source";
    await seedRun(ownerPool(), runId, "paused");

    const writer = new DirectRunStateWriter(runtimePool());
    await writer.resumePausedRunAtomic(buildInput(runId));

    const evt = await ownerPool().query<{ payload: { source?: string } }>(
      "SELECT payload FROM events WHERE run_id = $1 AND event_type = 'dag.spec.redriven'",
      [runId],
    );
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0]?.payload.source).toBe("prober_resume");
  });
});
