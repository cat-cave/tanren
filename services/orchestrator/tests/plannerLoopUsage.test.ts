// P2A-cost-monitors-wiring: the planner loop's usage integration. A UsageProbe
// supplies live subscription-window state (codexbar) for the pre-flight and
// run-cumulative token accounting (ccusage) for end-of-run cost reconciliation.
import { describe, expect, it } from "vitest";
import type { CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { defaultLoopInput } from "./helpers/plannerLoopHelpers.js";

function healthyWindow(): WindowObservation {
  return {
    usage: {
      provider: "openai",
      windows: [
        {
          slot: "primary",
          usedPercent: 20,
          resetsAt: "2026-06-01T00:00:00Z",
          windowMinutes: 300,
          resetDescription: "soon",
        },
      ],
      creditsRemaining: null,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "2026-05-28T00:00:00Z",
    },
    pressure: null,
  };
}

function exhaustedWindow(): WindowObservation {
  const slot = {
    slot: "secondary" as const,
    usedPercent: 100,
    resetsAt: "2026-05-30T20:19:33Z",
    windowMinutes: 10080,
    resetDescription: "May 30",
  };
  return {
    usage: {
      provider: "openai",
      windows: [
        {
          slot: "primary",
          usedPercent: 5,
          resetsAt: "2026-06-01T00:00:00Z",
          windowMinutes: 300,
          resetDescription: "soon",
        },
        slot,
      ],
      creditsRemaining: 0,
      accountEmail: null,
      source: "codex-cli",
      capturedAt: "2026-05-28T00:00:00Z",
    },
    pressure: slot,
  };
}

function accounting(costUsd: number | null): CcusageAccounting {
  return {
    cli: "codex",
    totals: {
      inputTokens: 8,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 12,
    },
    costUsd,
    perModel: [],
    capturedAt: "2026-05-28T00:00:00Z",
  };
}

function fakeProbe(window: WindowObservation, acct: CcusageAccounting | null): UsageProbe {
  return {
    async observeWindow() {
      return window;
    },
    async observeAccounting() {
      return acct;
    },
  };
}

describe("subtask loop — usage probe wiring", () => {
  it("emits the window-observed + accounting events and reconciles ccusage cost on a healthy run", async () => {
    const { input, pool, events } = defaultLoopInput({
      usageProbe: fakeProbe(healthyWindow(), accounting(0.6)),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("usage.window.observed");
    expect(names).toContain("usage.accounting.observed");
    expect(names).not.toContain("usage.window.pressure");

    // Real ccusage cost was apportioned across every cost_records row of the run.
    expect(pool.costUpdates).toHaveLength(pool.costInserts.length);
    const summed = pool.costUpdates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(0.6, 5);
  });

  it("escalates window pressure and halts BEFORE dispatching the planner", async () => {
    const { input, pool, events } = defaultLoopInput({
      usageProbe: fakeProbe(exhaustedWindow(), accounting(null)),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("window_exhausted");
    if (outcome.kind !== "window_exhausted") return;
    expect(outcome.slot).toBe("secondary");
    expect(outcome.usedPercent).toBe(100);
    expect(outcome.provider).toBe("openai");

    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("usage.window.observed");
    expect(names).toContain("usage.window.pressure");
    // No planner dispatch happened — the loop bailed at the pre-flight.
    expect(names).not.toContain("planner.subtasks.emitted");
    expect(pool.tasks.filter((task) => task.kind !== "plan")).toHaveLength(0);
    const plannerTask = pool.tasks.find((task) => task.kind === "plan")!;
    expect(plannerTask.outcome).toBe("window_exhausted");
  });

  it("emits accounting but does NOT reconcile when ccusage reports no cost (honest NULL)", async () => {
    const { input, pool, events } = defaultLoopInput({
      usageProbe: fakeProbe(healthyWindow(), accounting(null)),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    expect(events.events.map((event) => event.eventType)).toContain("usage.accounting.observed");
    expect(pool.costUpdates).toHaveLength(0);
  });

  it("prices a run from credit drawdown (overriding ccusage) when credits are consumed", async () => {
    // observeWindow yields 1000 credits at the pre-flight, 990 at the run-end
    // read → 10 credits consumed × $0.04 = $0.40, apportioned across the run's
    // cost rows. ccusage reports a positive (notional) cost that must be
    // overridden by the real credit drawdown.
    const creditQueue = [1000, 990];
    const probe: UsageProbe = {
      async observeWindow(): Promise<WindowObservation> {
        const remaining = creditQueue.shift() ?? 990;
        return {
          usage: {
            provider: "openai",
            windows: [
              {
                slot: "primary",
                usedPercent: 30,
                resetsAt: "2026-06-01T00:00:00Z",
                windowMinutes: 300,
                resetDescription: "soon",
              },
            ],
            creditsRemaining: remaining,
            accountEmail: null,
            source: "codex-cli",
            capturedAt: "2026-05-28T00:00:00Z",
          },
          pressure: null,
        };
      },
      async observeAccounting() {
        return accounting(5);
      },
    };

    const { input, pool } = defaultLoopInput({ usageProbe: probe, creditUsdRate: 0.04 });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    expect(pool.costUpdates.length).toBe(pool.costInserts.length);
    expect(pool.costUpdates.every((update) => update.basis === "credits")).toBe(true);
    const summed = pool.costUpdates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(0.4, 5);
  });

  it("runs exactly as before when no usage probe is supplied", async () => {
    const { input, events } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    const names = events.events.map((event) => event.eventType);
    expect(names).not.toContain("usage.window.observed");
    expect(names).not.toContain("usage.accounting.observed");
  });
});
