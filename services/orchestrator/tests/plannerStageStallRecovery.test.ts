// PLANNER STAGE answerer-stall RECOVERY (apex v70 fix).
//
// The finding: on the v70 apex run (run_08dde011-2892-4183-b5bc-81d0319ef9e9 on
// v70_postgres_1), the subtask-loop's INNER progress was healthy — writer.subtask.completed,
// gate.passed (fast + slow), checker.verdict complete:true, auditor.verdict clean,
// designOracle.verdict, convergence.assessed said "progress → keep_going" — then the NEXT
// plan-step iteration's LLM Answerer STALLED once. The plan stage was the only loop stage
// NOT wrapped in `runAnswererStageWithRecovery` (checker at subtaskStages.ts:317,
// demoRun/triage/convergence at loopStages.ts:124/287/416, auditor at auditorStage.ts:103,
// designOracle at designOracleLoopStage.ts:59 — all wrapped; the plan stage at
// subtaskStages.ts:90 called `invokePlanner` directly). A single transient stall propagated
// straight out of runSubtaskLoop → the whole run failed → the fixed-point classifier
// declared needs_attention, discarding the sibling progress the writer/checker/auditor/
// designOracle had already produced.
//
// The fix: wrap the plan stage's `invokePlanner` in `runAnswererStageWithRecovery("plan", ...)`
// exactly like every sibling loop stage. A transient stall RE-DRIVES the SAME plan call in
// place (sibling progress preserved — no whole-run restart, no needs_attention); a genuinely-
// wedged planner (a stall on EVERY re-drive — a proven fixed point, not a count) escalates
// LOUDLY via `StageStallEscalationError`, propagating to the workflow catch-all exactly as
// the bare stall throw would have.
//
// These tests prove BOTH sides on the plan stage specifically:
//   - a transient plan-Answerer stall is RECOVERED (re-driven in place; the plan stage
//     completes on the retry, `planner.subtasks.emitted` still fires with the real subtasks);
//   - a persistent plan-Answerer stall escalates LOUDLY at a proven fixed point (never a
//     silent count, never a whole-run brick on the first blip);
//   - a genuine (non-stall) deterministic error propagates verbatim — NOT re-driven.
//
// All seams are fakes under tests/ — NO real LLM/runner/DB. The pattern mirrors
// `mergePathStallRecovery.test.ts` (the conflict-resolver / simulated-reviewer path) and
// `loopStageStallRecovery.test.ts` (the shared primitive + wired-through-runSubtaskLoop).

import { describe, expect, it } from "vitest";
import { runPlannerStage } from "../src/engine/workflow/subtaskStages.js";
import { StageStallEscalationError } from "../src/engine/workflow/loopStageRecovery.js";
import { AnswererStalledError } from "../src/engine/providers/answererSchemaError.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

// A plan adapter that throws `AnswererStalledError` (the typed TRANSIENT stall the real
// codex/claude adapters surface — the exact family v70 hit for schema tanren.plan_answer.v1)
// for the first `stallTimes` calls, then returns the scripted plan. `Number.POSITIVE_INFINITY`
// = stalls on EVERY call (a wedge). Records call count so the tests can prove re-drive
// (not a count / not a first-blip brick).
function stallingPlanAdapter(
  stallTimes: number,
  plan: PlanAnswer,
  calls: { count: number },
): AnswererAdapter<PlanAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/fake",
    runAnswerer: async (opts) => {
      calls.count += 1;
      if (calls.count <= stallTimes) throw new AnswererStalledError(opts.outputSchema.name);
      return opts.outputSchema.parse(plan);
    },
  };
}

// A plan adapter that throws a DETERMINISTIC (non-stall) error — proves the wrapper does
// NOT re-drive a non-transient failure (schema/contract/infra crashes are the stage's own
// handling, not this wrapper's).
function crashingPlanAdapter(message: string, calls: { count: number }): AnswererAdapter<PlanAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/fake",
    runAnswerer: async () => {
      calls.count += 1;
      throw new Error(message);
    },
  };
}

// Recorded appendEvent — the tests assert the plan stage still fires
// `planner.subtasks.emitted` after a transient-stall recovery (event lands ONCE with the
// real subtasks, no phantom).
interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

class PlannerStageHarness {
  readonly events: RecordedEvent[] = [];
  readonly costRecords: Array<{ taskId: string; runtimeSeconds: number; rawUsage: Record<string, unknown> }> = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
        taskId: input.taskId,
      });
    },
  });

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  query = async (): Promise<{ rows: never[]; rowCount: number }> => ({ rows: [], rowCount: 1 });

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async (
        context: { taskId: string; runtimeSeconds: number },
        _tokenUsage: Record<string, unknown>,
        rawUsage: Record<string, unknown>,
      ) => {
        this.costRecords.push({
          taskId: context.taskId,
          runtimeSeconds: context.runtimeSeconds,
          rawUsage,
        });
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  find(eventType: EventName): RecordedEvent | undefined {
    return this.events.find((event) => event.eventType === eventType);
  }
}

const PLAN: PlanAnswer = {
  rationale: "decompose by behavior",
  subtasks: [
    {
      index: 0,
      title: "Wire behavior B1",
      intent: "touch the README",
      behaviorIds: ["B1"],
      estimatedTokens: null,
    },
  ],
};

const SPEC = {
  specTitle: "S",
  specDescription: "D",
  acceptanceCriteria: ["AC1"],
  behaviorIds: [],
  behaviorContext: [],
};

describe("plan stage — planner-Answerer stall recovery (apex v70 fix)", () => {
  it("RE-DRIVES a transient plan-Answerer stall and returns the plan (no whole-run brick)", async () => {
    const calls = { count: 0 };
    const h = new PlannerStageHarness();
    const result = await runPlannerStage({
      pool: { query: h.query },
      writer: h.writer,
      costCtx: h.costCtx(),
      adapter: stallingPlanAdapter(2, PLAN, calls),
      spec: SPEC,
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      appendEvent: h.appendEvent,
      attempt: 1,
      rejectionHistory: [],
    });
    // The plan stage re-drove through both transient stalls IN PLACE and returned the real
    // plan — it did NOT propagate the stall up to a whole-run failure.
    expect(result).toEqual(PLAN);
    // Re-driven until success (NOT a fixed count): 2 stalls then the plan.
    expect(calls.count).toBe(3);
    // Sibling progress preserved: the `planner.subtasks.emitted` event still fires with the
    // real subtasks — the stall did not orphan the timeline (fires exactly ONCE).
    const emitted = h.find("planner.subtasks.emitted");
    expect(emitted).toBeDefined();
    expect(emitted!.taskId).toBe("task_plan");
    const subtasks = emitted!.payload.subtasks as Array<Record<string, unknown>>;
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]).toMatchObject({ index: 0, title: "Wire behavior B1", intent: "touch the README" });
    // Cost recorded exactly once (the stall re-drives were not recorded as separate calls).
    expect(h.costRecords).toHaveLength(1);
    expect(h.costRecords[0]!.taskId).toBe("task_plan");
  });

  it("ESCALATES LOUDLY only at a real fixed point (the plan Answerer stalls on EVERY re-drive)", async () => {
    const calls = { count: 0 };
    const h = new PlannerStageHarness();
    await expect(
      runPlannerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        // Stalls forever → the convergence detector proves a fixed point → escalate.
        adapter: stallingPlanAdapter(Number.POSITIVE_INFINITY, PLAN, calls),
        spec: SPEC,
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        appendEvent: h.appendEvent,
        attempt: 1,
        rejectionHistory: [],
      }),
    ).rejects.toThrow(StageStallEscalationError);
    // It RE-DROVE first (>1 call) — the escalation is the PROVEN fixed point, not the
    // first transient blip and not a hardcoded count.
    expect(calls.count).toBeGreaterThanOrEqual(2);
    // The stall path never reaches `planner.subtasks.emitted` — no phantom emit on a wedge.
    expect(h.find("planner.subtasks.emitted")).toBeUndefined();
  });

  it("does NOT re-drive a deterministic (non-stall) error — it propagates verbatim on the first call", async () => {
    const calls = { count: 0 };
    const h = new PlannerStageHarness();
    await expect(
      runPlannerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: crashingPlanAdapter("ssh transport died", calls),
        spec: SPEC,
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        appendEvent: h.appendEvent,
        attempt: 1,
        rejectionHistory: [],
      }),
    ).rejects.toThrow(/ssh transport died/u);
    // A deterministic error is NOT a transient stall — it is NOT re-driven (one call only).
    expect(calls.count).toBe(1);
  });
});
