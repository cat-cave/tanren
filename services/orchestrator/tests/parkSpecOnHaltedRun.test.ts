// apex v22 run-discipline finding #3: a DAG spec stuck in `in_flight` is
// unrecoverable. A terminal-failed/halted run used to finalize the RUN to
// halted/failed but leave the SPEC at `in_flight` — which the DagWalker maps to
// OCCUPYING-A-SLOT, so the walker never re-attempts and neither operator-API path
// (`requeue` needs_attention-only, `runs` open-only) can recover it. This suite
// proves the fix: every terminal run outcome transitions the spec OUT of `in_flight`
// to the operator-recoverable `needs_attention` (freeing the slot + emitting the loud
// `dag.spec.needs_attention`), AND the requeue path can re-enter it at `open`.

import { describe, expect, it } from "vitest";
import {
  finalizeWorkflowError,
  parkSpecNeedsAttentionForHaltedRun,
} from "../src/engine/workflow/plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { isAllowedSpecTransition } from "../src/engine/state/spec.js";
import { MissingCredentialError } from "../src/engine/credentials/resolveCredentials.js";

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
  return { runId: "run_1", specId: "spec_1", projectId: "project_1" } as unknown as PlannerRunContext;
}

/** A recording appendEvent + the in-process finalizeRunState the real workflow uses. */
function harness(pool: RecordingPool) {
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
  const input = { pool: pool.asPgPool() } as unknown as RunPlannerLoopInput;
  return { events, appendEvent, finalizeRunState, input };
}

/** The `dag.spec.needs_attention` event the park emitted (asserts it is loud + typed). */
function needsAttention(events: CapturedEvent[]): { source: string; reason: string; message: string } | undefined {
  const e = events.find((x) => x.eventType === "dag.spec.needs_attention");
  return e === undefined ? undefined : (e.payload as { source: string; reason: string; message: string });
}

describe("parkSpecNeedsAttentionForHaltedRun — finding #3 never-strand", () => {
  it("transitions the spec out of in_flight to needs_attention + emits the loud event", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, input } = harness(pool);

    await parkSpecNeedsAttentionForHaltedRun(input, ctx(), appendEvent, "retry_budget_exhausted");

    // The SPEC left in_flight for the operator-recoverable needs_attention.
    expect(pool.specStatusWritten()).toBe("needs_attention");
    // A loud, typed escalation event was emitted (source `strand`, framed as a decision).
    const na = needsAttention(events);
    expect(na?.source).toBe("strand");
    expect(na?.reason).toBe("halted_reexec");
    expect(na?.message).toContain("requeue");
  });

  it("the needs_attention status is operator-requeueable (the recovery path)", () => {
    // The requeue endpoint flips `needs_attention → open`; the state machine permits
    // exactly that exit, so a parked spec is genuinely recoverable over the API.
    expect(isAllowedSpecTransition("needs_attention", "open")).toBe(true);
    // And from in_flight the park transition itself is legal.
    expect(isAllowedSpecTransition("in_flight", "needs_attention")).toBe(true);
  });
});

describe("finalizeWorkflowError — an infra failure parks the spec (not just halts the run)", () => {
  it("a MissingCredentialError halts the run AND parks the spec for requeue", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);

    // The exact apex v22 infra failure: the run threw MissingCredentialError.
    await finalizeWorkflowError(new MissingCredentialError("github_token"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    // The RUN finalizes failed (a generic hard error), and crucially the SPEC is
    // parked at needs_attention — NOT silently stranded at in_flight.
    expect(pool.terminalRunWrite()).toEqual({ status: "failed", outcome: "failed" });
    expect(pool.specStatusWritten()).toBe("needs_attention");
    expect(needsAttention(events)?.source).toBe("strand");
  });

  it("a recoverable usage-limit halt also parks the spec", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);
    const { CodexUsageLimitError } = await import("../src/engine/providers/codex.js");

    await finalizeWorkflowError(new CodexUsageLimitError("primary", "out of quota"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "window_exhausted" });
    expect(pool.specStatusWritten()).toBe("needs_attention");
    expect(needsAttention(events)?.reason).toBe("halted_reexec");
  });
});

describe("finalizeWorkflowError — a NON-TERMINAL headless ancestor benign-WAITS, never strands (apex v35)", () => {
  it("an AncestorNotReadyError returns the spec to OPEN (re-driven) + emits ancestor_not_ready — NOT needs_attention", async () => {
    const pool = new RecordingPool();
    const { events, appendEvent, finalizeRunState, input } = harness(pool);
    const { AncestorNotReadyError } = await import("../src/engine/dag/jjLocalIntegration.js");

    // The dependent reached its base-shift assembly but its ancestor `deploy` (spec
    // `spec_deploy`) was still `in_flight` — no PR/branch published yet. WITHOUT the benign
    // branch this would land like any other hard error: run `failed`, spec parked
    // `needs_attention` (a TERMINAL strand). WITH it: the run halts recoverable + the spec
    // returns to `open` so the walker re-drives it once the ancestor publishes its head.
    await finalizeWorkflowError(new AncestorNotReadyError("spec_deploy", "tanren/deploy-x", "in_flight", "main"), {
      finalizeRunState,
      appendEvent,
      workspacePath: "/workspace/runs/run_1",
      input,
      context: ctx(),
    });

    // The run HALTED (recoverable, work not discarded) — NOT `failed`.
    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
    // The dependent's SPEC returned to `open` (the walker's re-drive bucket), NOT
    // `needs_attention` — it does NOT terminally strand.
    expect(pool.specStatusWritten()).toBe("open");
    expect(needsAttention(events)).toBeUndefined();
    // The benign-wait was surfaced loudly (never silent) with the ancestor + its phase.
    const wait = events.find((e) => e.eventType === "dag.spec.ancestor_not_ready");
    expect(wait?.payload).toMatchObject({
      specId: "spec_1",
      runId: "run_1",
      ancestorSpecId: "spec_deploy",
      ancestorPhase: "in_flight",
    });
  });

  it("open is a re-drive-eligible status (the walker picks it up) — the never-discard re-drive, not a strand", () => {
    // `open` maps to the walker's `pending` bucket (a spec it MAY start), so the dependent is
    // genuinely re-driven on a later tick — the never-discard re-drive, no operator poke.
    expect(isAllowedSpecTransition("in_flight", "open")).toBe(true);
  });
});
