// Mutation ratchet (run-loop cluster): subtaskRework.ts owns the rework-routing
// helpers — handleRejection (budget boundary + planner.rerequested feedback) and
// gateRejection (the gate-failure → planner-feedback record). The baseline left
// the exact budget comparison, the rerequest payload, and the rendered gate
// reason string unpinned. These are (near-)pure functions; the tests assert the
// observable return value + the emitted event payload.
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { gateRejection, handleRejection } from "../src/engine/workflow/subtaskRework.js";
import type { PlannerRejectionFeedback } from "../src/engine/workflow/planner/planner.js";

function recorder() {
  const events: Array<{ eventType: EventName; payload: Record<string, unknown>; taskId?: string }> = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };
  return { events, appendEvent };
}

const rejection: PlannerRejectionFeedback = {
  producer: "checker",
  rejectionReason: "intent unmet",
  behaviorIdsFailed: ["B1", "B2"],
  previousSubtasks: [],
};

describe("handleRejection — budget boundary + rerequest feedback", () => {
  it("emits planner.rerequested and reports not-exhausted while within budget", async () => {
    const { events, appendEvent } = recorder();
    // plannerRerunCount 0, max 3 → nextCount 1 ≤ 3 → not exhausted.
    const history: PlannerRejectionFeedback[] = [];
    const exhausted = await handleRejection({
      appendEvent,
      plannerTaskId: "task_p",
      runId: "run_x",
      max: 3,
      rejection,
      plannerRerunCount: 0,
      history,
    });

    expect(exhausted).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("planner.rerequested");
    expect(events[0]!.payload).toMatchObject({
      runId: "run_x",
      plannerTaskId: "task_p",
      producer: "checker",
      rejectionReason: "intent unmet",
      behaviorIdsFailed: ["B1", "B2"],
      plannerRerunCount: 1,
      maxPlannerRerunsPerSpec: 3,
    });
    // The rejection is pushed onto history so the next plan carries it.
    expect(history).toEqual([rejection]);
  });

  it("reports exhausted (and emits no event, pushes no history) exactly at the boundary", async () => {
    const { events, appendEvent } = recorder();
    const history: PlannerRejectionFeedback[] = [];
    // plannerRerunCount 3, max 3 → nextCount 4 > 3 → exhausted.
    const exhausted = await handleRejection({
      appendEvent,
      plannerTaskId: "task_p",
      runId: "run_x",
      max: 3,
      rejection,
      plannerRerunCount: 3,
      history,
    });

    expect(exhausted).toBe(true);
    expect(events).toHaveLength(0);
    expect(history).toEqual([]);
  });

  it("is still within budget at the last allowed rerun (off-by-one guard)", async () => {
    const { appendEvent } = recorder();
    // plannerRerunCount 2, max 3 → nextCount 3 ≤ 3 → NOT exhausted.
    const exhausted = await handleRejection({
      appendEvent,
      plannerTaskId: "task_p",
      runId: "run_x",
      max: 3,
      rejection,
      plannerRerunCount: 2,
      history: [],
    });
    expect(exhausted).toBe(false);
  });
});

const failedGate = (exitCode: number | null): Extract<GateOutcome, { passed: false }> => ({
  passed: false,
  results: [],
  failure: { passed: false, tier: "fast", when: "per_iteration", failedStep: "lint", exitCode, steps: [] },
});

describe("gateRejection — gate-failure feedback record", () => {
  it("names the tier, lifecycle point, failing step, and exit code, with empty behaviorIdsFailed", () => {
    const record = gateRejection(failedGate(1), [
      { index: 0, title: "S", intent: "i", behaviorIds: [], estimatedTokens: null },
    ]);
    expect(record.producer).toBe("gate");
    expect(record.rejectionReason).toBe('gate tier "fast" (per_iteration) failed at step "lint" with exit 1');
    // The gate carries no per-behavior verdict.
    expect(record.behaviorIdsFailed).toEqual([]);
    // Prior subtasks are carried forward for the planner's context.
    expect(record.previousSubtasks).toHaveLength(1);
  });

  it("renders the no-exit-code phrasing when the gate timed out / substrate-failed", () => {
    const record = gateRejection(failedGate(null), []);
    expect(record.rejectionReason).toBe(
      'gate tier "fast" (per_iteration) failed at step "lint" with no exit code (timed out or substrate failure)',
    );
  });
});
