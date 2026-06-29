// apex v67 fixes #119 + #120 — RE-DRIVE halt OBSERVABILITY.
//
// v67's diagnostic gap: when the workflow's re-drive catch halts a run (the
// `dag.spec.redriven` path in `plannerRunRedrive.ts`), the prior code emitted
// ONLY the spec-side `dag.spec.redriven` event — NO public `run.failed`
// (watchers/observers/UI that key on the canonical halt event were blind to
// this halt class), and NO raw error capture on `job_queue.failure_message`
// (the worker-level `runExecutor.ts` `job_queue.failure_message` write only
// fires on the WORKER catch — the workflow's re-drive catch never reaches it).
// apex v67's halted spec ran 1h47m through three wandering failure codes with
// ZERO actionable detail for the operator to root-cause.
//
// The fix: `applyRedrive` (in `plannerRunRedrive.ts`) now routes the
// run-finalize through a NEW atomic seam (`finalizeRedriveAtomic`) that runs
// THREE writes in ONE transaction:
//   1. UPDATE runs SET status='halted', outcome=<runOutcome>
//   2. Append `run.failed` event (paired, public-safe payload — same shape as
//      the worker-level emit in `runExecutor.ts` / `runFinalize.ts`)
//   3. UPDATE job_queue.failure_message for this run's claimed `running` job
//      (internal-only, outside RLS) so the raw error string is preserved for
//      operator triage.
// A throw anywhere rolls back the whole transaction, so the run is never
// stranded `halted` without its `run.failed` event.
//
// THIS SUITE pins the APPLIER's contract: a re-drive on a classified failure
// invokes `finalizeRedriveAtomic` with the matching payload + the raw error
// message, and a synthesized throw inside the atomic seam aborts both the run
// finalize AND the subsequent spec flip (the workflow `catch` then re-raises).
// The DURABILITY layer (the actual one-tx commit of UPDATE+event+job_queue)
// is pinned by the conformance suite `finalizeRunWithEventAtomic.test.ts` for
// the run+event pair, against a real Postgres under enforced RLS.

import { describe, expect, it } from "vitest";
import { applyTerminalOutcome } from "../src/engine/workflow/plannerRunRedrive.js";
import type { DispositionSeams } from "../src/engine/workflow/plannerRunRedrive.js";
import type { TerminalOutcome } from "../src/engine/workflow/runFinalizeAuthority.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";

// Recording every disposition-seam call so we can assert the applier dispatched
// the right writes in the right order. Each seam captures its inputs; the
// `failNext` knobs let a test synthesize a throw at a specific seam (proving
// the applier propagates the throw so the workflow `catch` re-raises and the
// downstream `updateSpecAtomic` never fires — the atomicity surface).
class RecordingSeams implements DispositionSeams {
  readonly calls: { op: string; args: unknown }[] = [];
  failOn: { op: string; error: Error } | undefined;

  private record(op: string, args: unknown): void {
    this.calls.push({ op, args });
    if (this.failOn?.op === op) {
      throw this.failOn.error;
    }
  }

  async finalizeNonPass(outcome: "halted" | "convergence_stalled"): Promise<void> {
    this.record("finalizeNonPass", { outcome });
  }
  async setSpecStatus(status: string): Promise<void> {
    this.record("setSpecStatus", { status });
  }
  async finalizeRunState(): Promise<void> {
    this.record("finalizeRunState", {});
  }
  async updateSpecAtomic(spec: { status: string; notFromStatuses?: string[] }, event: AppendEventInput): Promise<void> {
    this.record("updateSpecAtomic", { spec, event });
  }
  async finalizeGenuineHaltAtomic(event: AppendEventInput): Promise<void> {
    this.record("finalizeGenuineHaltAtomic", { event });
  }
  async finalizePauseForCapacityAtomic(event: AppendEventInput): Promise<void> {
    this.record("finalizePauseForCapacityAtomic", { event });
  }
  async finalizeRedriveAtomic(input: {
    runOutcome: "halted" | "convergence_stalled";
    runFailedEvent: AppendEventInput;
    rawErrorMessage: string;
  }): Promise<void> {
    this.record("finalizeRedriveAtomic", input);
  }

  /** The captured call for an op, or undefined if not invoked. */
  callFor(op: string): { op: string; args: unknown } | undefined {
    return this.calls.find((c) => c.op === op);
  }
}

/** The minimal disposition context the applier reads (runId/specId/projectId/orgId).
 * `redriveHistoryReader` returns 0 (progress / first of its kind) so the disposition is a
 * RE-DRIVE, never a fixed-point escalation. */
function ctx() {
  return {
    appendEvent: async () => {
      /* no-op for the unit test — the applier does not read its return */
    },
    input: { redriveHistoryReader: async () => 0 },
    context: { runId: "run_1", specId: "spec_1", projectId: "project_1", orgId: "org_1" },
  } as const;
}

// A bespoke error class so the run-failure classifier maps it to a known code
// (`WorkspaceBootstrapError` → `workspace` @ `workspace`; the same class apex v67
// halted on). Defined here so the test does not import the workspace module just for
// the constructor shape.
class WorkspaceBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBootstrapError";
  }
}

describe("apex v67 fix #119 — re-drive halt emits `run.failed` atomically with the row UPDATE", () => {
  it("an error outcome routes to `finalizeRedriveAtomic` with a public-safe run.failed payload", async () => {
    const seams = new RecordingSeams();
    const error = new WorkspaceBootstrapError(
      "workspace bootstrap failed: just bootstrap exited 1 (raw stdout would carry secrets)",
    );

    const bucket = await applyTerminalOutcome({ kind: "error", error }, ctx(), seams);

    expect(bucket).toBe("re_drive");
    // The new atomic seam was invoked — the prior split `finalizeNonPass` is gone
    // from the failure-classified re-drive path (the legacy seam still backs the
    // no-fault ancestor-wait / merge-hold case; see the test below).
    const redrive = seams.callFor("finalizeRedriveAtomic");
    expect(redrive).toBeDefined();
    expect(seams.callFor("finalizeNonPass")).toBeUndefined();
    // Run outcome is the recoverable `halted` (NOT a terminal `failed`).
    expect((redrive!.args as { runOutcome: string }).runOutcome).toBe("halted");
    // `run.failed` event is the worker-emit shape: `status: "halted"` (recoverable),
    // closed-vocabulary failureCode + stage + a FIXED safe summary (never the raw string).
    const event = (redrive!.args as { runFailedEvent: AppendEventInput }).runFailedEvent;
    expect(event.eventType).toBe("run.failed");
    expect(event.runId).toBe("run_1");
    expect(event.specId).toBe("spec_1");
    expect(event.projectId).toBe("project_1");
    expect(event.payload).toMatchObject({
      status: "halted",
      failureCode: "workspace",
      stage: "workspace",
      message: "workspace bootstrap failed",
    });
    // The public payload never echoes the raw caught string (the hardening invariant).
    expect(JSON.stringify(event.payload)).not.toContain("raw stdout would carry secrets");
  });

  it("the spec flip + dag.spec.redriven event fires AFTER the run-finalize atomic seam", async () => {
    const seams = new RecordingSeams();
    await applyTerminalOutcome({ kind: "error", error: new WorkspaceBootstrapError("bootstrap failed") }, ctx(), seams);

    // The applier order: run-level atomic first (UPDATE+run.failed+failure_message),
    // then the spec-level atomic (UPDATE specs + dag.spec.redriven). A reader scanning
    // the timeline by ts sees BOTH events for a halted re-drive.
    const order = seams.calls.map((c) => c.op);
    expect(order).toContain("finalizeRedriveAtomic");
    expect(order).toContain("updateSpecAtomic");
    expect(order.indexOf("finalizeRedriveAtomic")).toBeLessThan(order.indexOf("updateSpecAtomic"));
    const spec = seams.callFor("updateSpecAtomic");
    const specEvent = (spec!.args as { event: AppendEventInput }).event;
    expect(specEvent.eventType).toBe("dag.spec.redriven");
  });
});

describe("apex v67 fix #120 — re-drive halt persists the raw caught error to job_queue.failure_message", () => {
  it("the raw `error.message` is threaded into the atomic seam's `rawErrorMessage`", async () => {
    const seams = new RecordingSeams();
    // A raw error message that would never be safe to put on the public timeline
    // (it would carry URLs / refs / command fragments / secret-adjacent text in apex).
    const rawMessage =
      "WorkspaceBootstrapError: command `just bootstrap` exited 2 (token=ghp_REDACTED at https://api.github.com/...)";
    await applyTerminalOutcome({ kind: "error", error: new WorkspaceBootstrapError(rawMessage) }, ctx(), seams);

    const redrive = seams.callFor("finalizeRedriveAtomic");
    expect(redrive).toBeDefined();
    // The raw message is threaded INTERNALLY (it will land on the
    // job_queue.failure_message column, outside RLS) — not on the public payload.
    expect((redrive!.args as { rawErrorMessage: string }).rawErrorMessage).toBe(rawMessage);
    // The PUBLIC run.failed payload's `message` is the classified safe summary
    // (never the raw string — the public-leak hardening invariant).
    const event = (redrive!.args as { runFailedEvent: AppendEventInput }).runFailedEvent;
    expect((event.payload as { message: string }).message).toBe("workspace bootstrap failed");
    expect((event.payload as { message: string }).message).not.toContain("ghp_");
  });

  it("a NON-error re-drive (no thrown error) falls back to the classified summary as the raw message", async () => {
    // A non-pass outcome (the writer never converged) re-drives but carries no thrown
    // error — there is no raw caught string to surface, so the failure_message takes
    // the classified safe summary as a fallback (still richer than nothing on
    // operator triage, while remaining safe).
    const seams = new RecordingSeams();
    const outcome: TerminalOutcome = { kind: "non_pass", detail: "convergence_stalled" };
    await applyTerminalOutcome(outcome, ctx(), seams);

    const redrive = seams.callFor("finalizeRedriveAtomic");
    expect(redrive).toBeDefined();
    // The classified summary for the non-pass detail (from `nonPassSummary`).
    expect((redrive!.args as { rawErrorMessage: string }).rawErrorMessage).toBe(
      "the planner loop stalled without converging",
    );
  });
});

describe("apex v67 fixes #119 + #120 — atomicity surface: a seam throw aborts the downstream writes", () => {
  it("a throw inside `finalizeRedriveAtomic` propagates — the spec flip + dag.spec.redriven NEVER fire", async () => {
    // Simulates a transient DB hiccup during the atomic run+event+failure_message tx.
    // The seam's underlying transaction rolls back ALL three writes (proven by the
    // `finalizeRunWithEventAtomic.test.ts` conformance suite against a real PG); HERE
    // we pin the APPLIER's contract that a throw propagates upward instead of being
    // swallowed (the workflow `catch` then resolves the throw — by re-raising
    // wrapped, the worker's safety-net finalizer takes over the run as an orphan).
    const seams = new RecordingSeams();
    const txError = new Error("synthesized DB hiccup mid-atomic-tx");
    seams.failOn = { op: "finalizeRedriveAtomic", error: txError };

    await expect(
      applyTerminalOutcome({ kind: "error", error: new WorkspaceBootstrapError("bootstrap failed") }, ctx(), seams),
    ).rejects.toBe(txError);

    // The downstream spec flip NEVER ran — the applier's seam order ensures the
    // spec is not flipped `open` (with a `dag.spec.redriven` event landed) while the
    // run is still `running` (the atomic seam rolled back). The orphan reconciler
    // owns the recovery (the worker's safety net catches the propagated throw).
    expect(seams.callFor("updateSpecAtomic")).toBeUndefined();
  });

  it("a NO-FAULT re-drive (ancestor_wait) still uses the legacy `finalizeNonPass` path (no run.failed emit)", async () => {
    // An ancestor-not-ready re-drive is a BENIGN wait, not a fault — the run did not
    // fail, it is correctly waiting on a non-terminal ancestor's head publish. We do
    // NOT want a public `run.failed` event for this (it would mis-imply a fault), so
    // the applier preserves the legacy bare run-finalize path for the no-fault case.
    const seams = new RecordingSeams();
    await applyTerminalOutcome({ kind: "ancestor_wait" }, ctx(), seams);

    expect(seams.callFor("finalizeNonPass")).toBeDefined();
    expect(seams.callFor("setSpecStatus")).toBeDefined();
    expect(seams.callFor("finalizeRedriveAtomic")).toBeUndefined();
    expect(seams.callFor("updateSpecAtomic")).toBeUndefined();
  });
});
