// apex v35 — the UNIFIED run-finalize at the WORKFLOW error boundary (finalizeWorkflowError).
// EVERY thrown run-error routes through the ONE authority and lands in exactly one bucket:
//   • a RANDOM/TRANSIENT/internal fault → RE-DRIVE (run halts recoverable, spec → `open`,
//     `dag.spec.redriven`) — never the old terminal park;
//   • a credential MISCONFIGURATION → GENUINE-HALT (run failed, spec `needs_attention`);
//   • the SAME failure K times → GENUINE-HALT `persistent_failure` (no hot-loop);
//   • a benign ancestor-wait → a NO-FAULT RE-DRIVE (spec → `open`, ancestor_not_ready).
// These assertions FAIL against the pre-redesign per-branch park logic (which parked the
// transient/usage-limit/workspace branches at `needs_attention`).

import { describe, expect, it } from "vitest";
import { finalizeWorkflowError } from "../src/engine/workflow/plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { isAllowedSpecTransition } from "../src/engine/state/spec.js";
import { MissingCredentialError } from "../src/engine/credentials/resolveCredentials.js";
import { type RedriveHistoryReader } from "../src/engine/workflow/plannerRunRedrive.js";

/** Records the spec-status UPDATEs + the run finalize so we can assert the transition. */
class RecordingPool {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  asPgPool() {
    return this as never;
  }
  /** The status the LAST `UPDATE specs SET status = $2` wrote, or undefined if none. */
  specStatusWritten(): string | undefined {
    const last = this.queries.findLast((q) => q.sql.startsWith("UPDATE specs SET status"));
    return last === undefined ? undefined : String(last.params[1]);
  }
  /** The terminal `UPDATE runs SET status` (status + outcome), or undefined. */
  terminalRunWrite(): { status: string; outcome: string } | undefined {
    const last = this.queries.findLast((q) => q.sql.startsWith("UPDATE runs SET status"));
    if (last === undefined) return undefined;
    if (last.sql.includes("status = 'halted'")) return { status: "halted", outcome: String(last.params[1]) };
    if (last.sql.includes("status = 'failed'")) return { status: "failed", outcome: "failed" };
    return undefined;
  }
}

interface CapturedEvent {
  eventType: string;
  payload: unknown;
}

function ctx(): PlannerRunContext {
  // `orgId` is present so the re-drive history reader (when wired) is consulted.
  return { runId: "run_1", specId: "spec_1", projectId: "project_1", orgId: "org_1" } as unknown as PlannerRunContext;
}

/** A recording appendEvent + the in-process finalizeRunState the real workflow uses. */
function harness(pool: RecordingPool, redriveHistoryReader?: RedriveHistoryReader) {
  const events: CapturedEvent[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    events.push({ eventType, payload });
  };
  const finalizeRunState = async (
    _status: string,
    _outcome: string,
    _from: string[],
    sql: string,
    params: unknown[],
  ): Promise<void> => {
    await pool.query(sql, params);
  };
  const input = {
    pool: pool.asPgPool(),
    ...(redriveHistoryReader !== undefined && { redriveHistoryReader }),
  } as unknown as RunPlannerLoopInput;
  return { events, appendEvent, finalizeRunState, input };
}

/** A fixed FIXED-POINT reader (0 ⇒ progress / re-drive; 1 ⇒ a fixed point / escalate — no count).
 * Always reports `wandering: false` so the wandering-halt detector (apex v67 #122) is a no-op
 * in these tests — the fixture exercises the fixed-point disposition. */
function readerReturning(fixedPointStreak: number): RedriveHistoryReader {
  return async () => ({ priorSameFixedPoint: fixedPointStreak, wandering: { wandering: false } });
}

/** The `dag.spec.redriven` event the re-drive emitted (asserts an OBSERVABLE retry, not a strand). */
function redriven(
  events: CapturedEvent[],
): { specId: string; runId: string; failureCode: string; consecutiveSameFailure: number } | undefined {
  const e = events.find((x) => x.eventType === "dag.spec.redriven");
  return e === undefined
    ? undefined
    : (e.payload as {
        specId: string;
        runId: string;
        failureCode: string;
        consecutiveSameFailure: number;
      });
}

/** The `dag.spec.needs_attention` event a GENUINE-HALT emitted (asserts it is loud + typed). */
function needsAttention(events: CapturedEvent[]): { source: string; reason: string; message: string } | undefined {
  const e = events.find((x) => x.eventType === "dag.spec.needs_attention");
  return e === undefined ? undefined : (e.payload as { source: string; reason: string; message: string });
}

describe("finalizeWorkflowError — a GENUINE-TERMINAL misconfiguration GENUINE-HALTS (not just halts the run)", () => {
  it("a MissingCredentialError (misconfiguration) lands the run failed AND escalates the spec with a SPECIFIC diagnostic", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);

    const disposition = await finalizeWorkflowError(new MissingCredentialError("github_token"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    // The unified bucket: a misconfiguration is a GENUINE-HALT.
    expect(disposition).toBe("genuine_halt");
    // The RUN finalizes failed; the SPEC parks at needs_attention — NOT stranded at in_flight, NOT re-driven.
    expect(pool.terminalRunWrite()).toEqual({ status: "failed", outcome: "failed" });
    expect(pool.specStatusWritten()).toBe("needs_attention");
    const na = needsAttention(events);
    expect(na?.source).toBe("strand");
    expect(na?.reason).toBe("misconfiguration");
    // FAIL-LOUD: a SPECIFIC, actionable diagnostic (the classified credential fault), never a bare error.
    expect(na?.message).toContain("credential");
    expect(na?.message).toContain("a human must fix");
    // And there is NO re-drive — a misconfiguration is never re-driven.
    expect(redriven(events)).toBeUndefined();
  });

  it("a recoverable usage-limit fault PAUSES (task #82 — pause_for_capacity bucket, spec stays in_flight, NOT needs_attention)", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool, readerReturning(0));
    const { CodexUsageLimitError } = await import("../src/engine/providers/codex.js");

    const disposition = await finalizeWorkflowError(new CodexUsageLimitError("primary", "out of quota"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    // task #82: a usage window is TRANSIENT WINDOW PRESSURE — routes to the
    // NEW `pause_for_capacity` bucket (NOT re-drive). The spec is intentionally
    // untouched (NO `open` flip, NO `dag.spec.redriven`); the background
    // prober owns the resume. Window pressure is UNBOUNDED — never escalates.
    expect(disposition).toBe("pause_for_capacity");
    expect(pool.specStatusWritten()).toBeUndefined();
    expect(needsAttention(events)).toBeUndefined();
    expect(redriven(events)).toBeUndefined();
    // The usage pressure is still surfaced loudly + `run.paused` rides the
    // atomic seam (provider/slot/usedPercent/resetsAt diagnostic for the prober).
    expect(events.find((e) => e.eventType === "usage.window.pressure")).toBeDefined();
    expect(events.find((e) => e.eventType === "run.paused")).toBeDefined();
  });

  it("a workspace-bootstrap fault RE-DRIVES (transient deps install), surfacing workspace.failed", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool, readerReturning(0));
    const { WorkspaceBootstrapError } = await import("../src/engine/workspace/index.js");

    const disposition = await finalizeWorkflowError(new WorkspaceBootstrapError("deps install failed"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    expect(disposition).toBe("re_drive");
    expect(pool.specStatusWritten()).toBe("open");
    expect(needsAttention(events)).toBeUndefined();
    expect(events.find((e) => e.eventType === "workspace.failed")).toBeDefined();
    expect(redriven(events)?.failureCode).toBe("workspace");
  });
});

describe("finalizeWorkflowError — a NON-TERMINAL headless ancestor benign-WAITS, never strands (apex v35)", () => {
  it("an AncestorNotReadyError returns the spec to OPEN (re-driven) + emits ancestor_not_ready — NOT needs_attention", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);
    const { AncestorNotReadyError } = await import("../src/engine/dag/jjLocalIntegration.js");

    const disposition = await finalizeWorkflowError(
      new AncestorNotReadyError("spec_deploy", "tanren/deploy-x", "in_flight", "main"),
      {
        finalizeRunState,
        appendEvent,
        workspacePath: "/workspace/runs/run_1",
        input,
        context: ctx(),
      },
    );

    expect(disposition).toBe("re_drive");
    // The run HALTED (recoverable, work not discarded) — NOT `failed`.
    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
    // The dependent's SPEC returned to `open`, NOT `needs_attention`.
    expect(pool.specStatusWritten()).toBe("open");
    expect(needsAttention(events)).toBeUndefined();
    // A benign wait carries NO fault — it emits ancestor_not_ready, NOT dag.spec.redriven (it
    // never counts toward the consecutive-same-failure cap).
    expect(redriven(events)).toBeUndefined();
    const wait = events.find((e) => e.eventType === "dag.spec.ancestor_not_ready");
    expect(wait?.payload).toMatchObject({
      specId: "spec_1",
      runId: "run_1",
      ancestorSpecId: "spec_deploy",
      ancestorPhase: "in_flight",
    });
  });

  it("open is a re-drive-eligible status (the walker picks it up) — the never-discard re-drive, not a strand", () => {
    expect(isAllowedSpecTransition("in_flight", "open")).toBe(true);
  });
});

describe("finalizeWorkflowError — a RANDOM / TRANSIENT failure is RE-DRIVEN, never terminally stranded (apex v35)", () => {
  it("a generic/internal error RE-DRIVES the spec (→ open + dag.spec.redriven), NOT needs_attention", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool, readerReturning(0));

    const disposition = await finalizeWorkflowError(new Error("the run failed with an internal error"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    expect(disposition).toBe("re_drive");
    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
    expect(pool.specStatusWritten()).toBe("open");
    expect(needsAttention(events)).toBeUndefined();
    const rd = redriven(events);
    expect(rd?.specId).toBe("spec_1");
    expect(rd?.failureCode).toBe("internal");
    expect(rd?.consecutiveSameFailure).toBe(1);
  });

  it("the SAME internal failure at a FIXED POINT GENUINE-HALTS once to needs_attention (a stuck spec) — never a hot-loop, no count", async () => {
    const pool = new RecordingPool();
    // The reader reports a fixed point (the prior attempt was structurally identical) ⇒ escalate.
    const { events, appendEvent, finalizeRunState, input } = harness(pool, readerReturning(1));

    const disposition = await finalizeWorkflowError(new Error("the run failed with an internal error"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    expect(disposition).toBe("genuine_halt");
    expect(pool.terminalRunWrite()).toEqual({ status: "failed", outcome: "failed" });
    expect(pool.specStatusWritten()).toBe("needs_attention");
    expect(redriven(events)).toBeUndefined();
    const na = needsAttention(events);
    expect(na?.source).toBe("strand");
    expect(na?.message).toContain("FIXED POINT");
    expect(na?.message).toContain("genuinely stuck");
    expect((na as { reason: string }).reason).toBe("persistent_failure");
  });

  it("without a wired reader (a no-DB unit path) a transient still RE-DRIVES (never a spurious escalation)", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);

    const disposition = await finalizeWorkflowError(new Error("some flaky internal blip"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    expect(disposition).toBe("re_drive");
    expect(pool.specStatusWritten()).toBe("open");
    expect(redriven(events)?.consecutiveSameFailure).toBe(1);
    expect(needsAttention(events)).toBeUndefined();
  });
});
