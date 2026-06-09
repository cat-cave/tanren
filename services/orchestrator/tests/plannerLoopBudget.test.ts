// Loop-level budget-enforcement + finalize-guard tests (audit §3.7a + §3.7d).
//
// §3.7a: the enqueue-time budget gate only stops NEW work — an ALREADY in-flight run
//   must ALSO halt the instant its project crosses the dollar ceiling, else an
//   over-ceiling cohort keeps spending past $50. runSubtaskLoop now re-resolves the
//   budget at the TOP of every iteration through the injectable BudgetGate seam.
// §3.7d: the run-end cost reconcile is BEST-EFFORT — a control-plane/probe blip must
//   NOT discard a finished run's outcome. finalize() now catches the reconcile throw.
import { describe, expect, it, vi } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import type { BudgetGate, ProjectBudgetState } from "../src/engine/contracts/dagWalker.js";
import type { UsageProbe } from "../src/engine/usage/index.js";
import { defaultLoopInput } from "./helpers/plannerLoopHelpers.js";

// A BudgetGate seam returning a fixed resolved state (the same shape PgBudgetGate yields).
function fakeBudgetGate(state: ProjectBudgetState): BudgetGate {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async resolveBudget(): Promise<ProjectBudgetState> {
      return state;
    },
  };
}

const overCeiling: ProjectBudgetState = {
  ceilingUsd: 50,
  period: "total",
  spentUsd: 62.5,
  notionalUsd: 62.5,
  gatedFigure: "real_spend",
};

const underCeiling: ProjectBudgetState = {
  ceilingUsd: 50,
  period: "total",
  spentUsd: 4.2,
  notionalUsd: 4.2,
  gatedFigure: "real_spend",
};

describe("spec loop — per-iteration budget gate (audit §3.7a)", () => {
  it("an OVER-CEILING in-flight run PAUSES before the planner (not just at enqueue)", async () => {
    const { input, pool, events } = defaultLoopInput({ budgetGate: fakeBudgetGate(overCeiling) });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("budget_paused");
    if (outcome.kind !== "budget_paused") return;
    expect(outcome.ceilingUsd).toBe(50);
    expect(outcome.spentUsd).toBe(62.5);

    // The pause fired the loud `dag.budget.paused` event.
    const paused = events.events.find((e) => e.eventType === "dag.budget.paused");
    expect(paused?.payload).toMatchObject({ ceilingUsd: 50, spentUsd: 62.5 });
    // The run halted BEFORE any planner/writer work — the cohort stops spending.
    expect(pool.tasks.map((t) => t.kind)).not.toContain("write");
    expect(events.events.map((e) => e.eventType)).not.toContain("planner.completed");
  });

  it("a FAIL-CLOSED budget (unpriced spend) also pauses the in-flight run", async () => {
    const failClosed: ProjectBudgetState = { ...underCeiling, failClosed: "unpriced_spend" };
    const { input } = defaultLoopInput({ budgetGate: fakeBudgetGate(failClosed) });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("budget_paused");
    if (outcome.kind !== "budget_paused") return;
    expect(outcome.reason).toBe("unpriced_spend");
  });

  it("an UNDER-CEILING budget does NOT pause — the loop runs to PASS normally", async () => {
    const { input } = defaultLoopInput({ budgetGate: fakeBudgetGate(underCeiling) });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
  });

  it("NO budget gate wired ⇒ no per-iteration enforcement (byte-identical to before)", async () => {
    const { input } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
  });
});

describe("spec loop — guarded finalize (audit §3.7d)", () => {
  it("a run-end reconcile FAILURE does NOT discard the finished run's outcome", async () => {
    // A usage probe whose run-end accounting read THROWS — a control-plane/probe blip.
    // The finished run's outcome (passed) MUST still return; only the best-effort spend
    // back-fill is lost. Without the guard, the throw would propagate and discard both.
    const throwingProbe: UsageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async observeWindow() {
        return { usage: null, pressure: null, failure: null };
      },
      async observeAccounting(): Promise<never> {
        throw new Error("control-plane blip during run-end reconcile");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { input } = defaultLoopInput({ usageProbe: throwingProbe });

    const outcome = await runSubtaskLoop(input);

    // The run outcome PERSISTS despite the reconcile throw.
    expect(outcome.kind).toBe("passed");
    // The failure was surfaced LOUD (not silently swallowed).
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
