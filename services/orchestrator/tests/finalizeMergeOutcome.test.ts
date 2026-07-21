// apex v35 — the run-loop merge finalize, UNIFIED to the 3-bucket model
// (autonomy-engine.md §2d). The CARDINAL-SIN fix holds: only a LANDED merge marks the
// spec `merged` (CONVERGE); a `native_queue` first-pass `queued` enqueue completes the run
// but leaves the spec non-done. The REDESIGN: only a genuine `needs_attention` (a HITL /
// changes-requested human-decision) GENUINE-HALTS; EVERY other hold — `blocked` (a
// transient authority refusal / CAS race), `conflict` (resolvable), `handed_off`, a
// non-native `queued`, `failed` — RE-DRIVES (spec → `open`, the walker re-attempts). The
// old "park `blocked`/`handed_off`/non-native-queued at `needs_attention`" was the
// whack-a-mole bug — a transient hold is NOT a human-decision.

import { describe, expect, it } from "vitest";
import { finalizeMergeOutcome } from "../src/engine/workflow/plannerRunFinalize.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { DispatchedIntegration, MergeOutcomeKind } from "../src/engine/workflow/reviewMerge/index.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";

/** A pool that records every UPDATE the finalize drives, so we can assert on them. */
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
  /** Whether ANY `UPDATE specs` ran (proves the spec status was / was not touched). */
  touchedSpec(): boolean {
    return this.queries.some((q) => q.sql.startsWith("UPDATE specs SET status"));
  }
  terminalRunWrite(): { status: string; outcome: string } | undefined {
    const last = this.queries.findLast((q) => q.sql.startsWith("UPDATE runs SET status"));
    if (last === undefined) return undefined;
    if (last.sql.includes("status = 'completed'")) return { status: "completed", outcome: "ok" };
    if (last.sql.includes("status = 'halted'")) return { status: "halted", outcome: String(last.params[1]) };
    if (last.sql.includes("status = 'failed'")) return { status: "failed", outcome: "failed" };
    return undefined;
  }
}

function ctx(): PlannerRunContext {
  return { runId: "run_1", specId: "spec_1", projectId: "project_1", orgId: "org_1" } as unknown as PlannerRunContext;
}

async function run(
  pool: RecordingPool,
  outcome: MergeOutcomeKind,
  integration: DispatchedIntegration,
): Promise<{ eventType: string; payload: unknown }[]> {
  const input = { pool: pool.asPgPool() } as unknown as RunPlannerLoopInput;
  const events: { eventType: string; payload: unknown }[] = [];
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
  await finalizeMergeOutcome(input, finalizeRunState, ctx(), appendEvent, { outcome, integration });
  return events;
}

describe("finalizeMergeOutcome — CONVERGE: only a landed merge marks the spec merged", () => {
  it("a native_queue first-pass `queued` enqueue leaves the spec NOT merged (run completes ok)", async () => {
    const pool = new RecordingPool();
    await run(pool, "queued", "native_queue");
    expect(pool.touchedSpec()).toBe(false);
    expect(pool.terminalRunWrite()).toEqual({ status: "completed", outcome: "ok" });
  });

  it("a native_queue DRIVE-pass `merged` marks the spec `merged` (CONVERGE)", async () => {
    const pool = new RecordingPool();
    await run(pool, "merged", "native_queue");
    expect(pool.specStatusWritten()).toBe("merged");
    expect(pool.terminalRunWrite()).toEqual({ status: "completed", outcome: "ok" });
  });

  it("a native_queue DRIVE-pass `merged` records a completed run", async () => {
    const pool = new RecordingPool();
    await run(pool, "merged", "native_queue");
    expect(pool.specStatusWritten()).toBe("merged");
    expect(pool.terminalRunWrite()).toEqual({ status: "completed", outcome: "ok" });
  });
});

describe("finalizeMergeOutcome — GENUINE-HALT: only a real human-decision parks", () => {
  it("a `needs_attention` outcome (a HITL / changes-requested decision) GENUINE-HALTS the spec", async () => {
    const pool = new RecordingPool();
    const events = await run(pool, "needs_attention", "native_queue");
    expect(pool.specStatusWritten()).toBe("needs_attention");
    expect(pool.terminalRunWrite()).toEqual({ status: "failed", outcome: "failed" });
    const na = events.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(na?.payload).toMatchObject({ reason: "human_decision" });
  });
});

describe("finalizeMergeOutcome — RE-DRIVE: every transient hold re-drives, never parks", () => {
  it.each<MergeOutcomeKind>(["blocked", "conflict", "handed_off"])(
    "a `%s` hold RE-DRIVES the spec to `open` (a transient hold, not a human-decision)",
    async (outcome) => {
      const pool = new RecordingPool();
      const events = await run(pool, outcome, "native_queue");
      expect(pool.specStatusWritten()).toBe("open");
      expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
      // No needs_attention park (the whack-a-mole bug is gone).
      expect(events.find((e) => e.eventType === "dag.spec.needs_attention")).toBeUndefined();
    },
  );

  it("an external-reviewer `queued` outcome RE-DRIVES the spec (not parks)", async () => {
    const pool = new RecordingPool();
    await run(pool, "queued", "external_reviewer");
    expect(pool.specStatusWritten()).toBe("open");
    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
  });

  it("a `failed` merge outcome RE-DRIVES the spec (a transient merge fault, work never discarded)", async () => {
    const pool = new RecordingPool();
    await run(pool, "failed", "external_reviewer");
    expect(pool.specStatusWritten()).toBe("open");
    expect(pool.terminalRunWrite()).toEqual({ status: "halted", outcome: "halted" });
  });
});
