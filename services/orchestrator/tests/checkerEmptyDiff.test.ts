// EMPTY-INCREMENTAL-DIFF (v35): the checker must ACCEPT a re-driven / scaffold spec
// whose acceptance criteria are met by the COMMITTED TREE even when the
// `baselineSha → HEAD` incremental diff is EMPTY. The live bug: the unified finalize
// re-drove a COMPLETE `scaffold` spec; its prior iteration's work was already
// committed in the base, so the writer correctly added nothing → an empty diff → the
// checker rejected ("no change / can't confirm the work") → rewrite → re-drive →
// `persistent_failure` escalation, on work that was ALREADY DONE.
//
// The fix is two-part and both parts are exercised here:
//   1. ROOT (prompt): the checker judges the RESULTING STATE — an empty diff is "no
//      regression to review", not an incompleteness — so it emits ZERO findings and
//      the loop ACCEPTS (asserted in answererPrompts.test.ts + via the stage here).
//   2. SAFETY NET (deterministic loop): a reject over an EMPTY diff is non-reworkable
//      (re-driving the writer cannot grow an empty diff), so the loop routes the
//      residual finding to triage instead of looping into a false `persistent_failure`.
//
// The split from subtaskStages.test.ts / plannerLoop.test.ts keeps every file under
// the 500-line architecture cap (mirroring checkerEntityRiskStage.test.ts).
import { describe, expect, it } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { runCheckerStage } from "../src/engine/workflow/subtaskStages.js";
import {
  completeCheck,
  defaultLoopInput,
  incompleteCheck,
  makeChecker,
  makeTriage,
  makeWriter,
  triageAllSpecs,
} from "./helpers/plannerLoopHelpers.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
}

// Audit finding H3 sweep: the checker's terminal seam now REQUIRES a writer.
// The harness wires the InMemoryRunStateWriter fixture; the writer's atomic
// terminal pair drives both the row state (read off `writer.tasks`) and the
// terminal event (forwarded into `events`).
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

class CheckerHarness {
  readonly events: RecordedEvent[] = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });
  get taskOutcomes(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.outcome !== null) {
        map.set(taskId, row.outcome);
      }
    }
    return map;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
    if (taskId !== undefined) void taskId;
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  find(name: EventName): RecordedEvent | undefined {
    return this.events.find((e) => e.eventType === name);
  }

  names(): EventName[] {
    return this.events.map((e) => e.eventType);
  }
}

function checkerArgs(h: CheckerHarness, verdict: typeof completeCheck) {
  return {
    pool: { query: h.query },
    writer: h.writer,
    costCtx: h.costCtx(),
    adapter: makeChecker([verdict]),
    runId: "run_1",
    workspacePath: "/ws",
    writeTaskId: "task_write",
    checkerTaskId: "task_check",
    subtask: { index: 0, title: "T", intent: "i", behaviorIds: ["B1"] },
    writerResult: { diff: "d", commits: [], exitReason: "completed" as const },
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

describe("runCheckerStage — empty-incremental-diff (v35)", () => {
  it("ACCEPTS a re-driven complete spec: empty diff + zero findings + criteria met by the tree ⇒ pass", async () => {
    // The classified EMPTY diff (zero changed entities) + a zero-findings verdict (the
    // checker judged the committed tree) MUST pass — never a reject that loops the
    // writer. emptyIncrementalDiff is observable on the verdict event, never forcing it.
    const h = new CheckerHarness();
    const decision = await runCheckerStage({
      ...checkerArgs(h, completeCheck),
      baseSha: "a".repeat(40),
      entityChangeMap: { entities: [] },
    });
    expect(decision.kind).toBe("pass");
    expect(h.names()).not.toContain("checker.rejected");
    expect(h.taskOutcomes.get("task_check")).toBe("passed");
    const verdict = h.find("checker.verdict")!;
    expect(verdict.payload.complete).toBe(true);
    expect(verdict.payload.emptyIncrementalDiff).toBe(true);
    expect(h.find("checker.entity_risk")!.payload.counts).toMatchObject({ total: 0 });
  });

  it("an EMPTY-diff reject (criteria genuinely unmet by the tree) is NON-reworkable — routes to triage, not the writer", async () => {
    // Criteria genuinely unmet (a finding) over an EMPTY diff: re-driving cannot grow an
    // empty diff, so the reject is non-reworkable. Still rejects (work is genuinely
    // incomplete) but the loop surfaces it to triage rather than re-drive forever.
    const h = new CheckerHarness();
    const decision = await runCheckerStage({
      ...checkerArgs(h, incompleteCheck),
      baseSha: "a".repeat(40),
      entityChangeMap: { entities: [] },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.reworkable).toBe(false);
    expect(h.names()).toContain("checker.rejected");
    expect(h.find("checker.verdict")!.payload.emptyIncrementalDiff).toBe(true);
  });

  it("a NON-empty-diff reject (a real finding) stays REWORKABLE — re-drives the writer as before", async () => {
    // A genuine regression over a NON-empty diff must still reject AND stay reworkable —
    // the writer can grow the diff to fix it. The empty-diff guard never weakens this.
    const h = new CheckerHarness();
    const decision = await runCheckerStage({
      ...checkerArgs(h, incompleteCheck),
      baseSha: "a".repeat(40),
      entityChangeMap: {
        entities: [{ kind: "modified", nature: "structural", visibility: "public", signatureChanged: true }],
      },
    });
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.reworkable).toBe(true);
    expect(h.find("checker.verdict")!.payload.emptyIncrementalDiff).toBe(false);
  });

  it("does NOT treat an UNKNOWN (unclassified) risk signal as an empty diff — only a real `classified` zero-count counts", async () => {
    // No producer / can't-parse ⇒ `unknown` provenance. We must NOT relabel that as an
    // empty diff (that would let an unwired oracle silently mark any diff empty). The
    // reject stays REWORKABLE and emptyIncrementalDiff is false.
    const h = new CheckerHarness();
    const decision = await runCheckerStage(checkerArgs(h, incompleteCheck));
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.reworkable).toBe(true);
    expect(h.find("checker.entity_risk")!.payload.provenance).toBe("no-producer");
    expect(h.find("checker.verdict")!.payload.emptyIncrementalDiff).toBe(false);
  });
});

describe("runSubtaskLoop — empty-incremental-diff does not false-escalate (v35)", () => {
  it("an incomplete checker over an EMPTY diff does NOT re-drive the writer — it routes to triage (no infinite rework)", async () => {
    // The bug at the loop level: with an EMPTY diff and a checker finding, the OLD loop
    // re-drove the writer endlessly (it correctly adds nothing → the diff stays empty →
    // the same finding → `persistent_failure`). With the guard the reject is
    // non-reworkable: the writer runs ONCE, the residual finding routes to triage, and
    // the loop converges — never an infinite re-drive.
    const writer = makeWriter(["only-attempt\n"]);
    const checker = makeChecker([incompleteCheck, incompleteCheck, incompleteCheck]);
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        writer,
        checker,
        triage: makeTriage([triageAllSpecs]),
      },
      entityRiskProducer: async () => ({ map: { entities: [] } }),
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // ONE writer + ONE checker pass — no futile re-drive.
    expect(writer.calls).toHaveLength(1);
    expect(checker.calls).toHaveLength(1);
    // The residual incompleteness routed to triage as a new spec — never halted.
    expect(outcome.newSpecs.length).toBeGreaterThan(0);
    const verdict = events.events.find((e) => e.eventType === "checker.verdict")!;
    expect((verdict.payload as { emptyIncrementalDiff: boolean }).emptyIncrementalDiff).toBe(true);
  });
});
