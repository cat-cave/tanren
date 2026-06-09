// P2A-cost-monitors-wiring: the planner loop's usage integration. A UsageProbe
// supplies live subscription-window state (codexbar) for the pre-flight and
// run-cumulative token accounting (ccusage) for end-of-run cost reconciliation.
import { describe, expect, it } from "vitest";
import type { CcusageAccounting, UsageProbe, WindowObservation } from "../src/engine/usage/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  cleanAudit,
  completeCheck,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  buildPlan,
} from "./helpers/plannerLoopHelpers.js";

// A drawing-down credit window: 1000 credits at the pre-flight, 990 at run-end →
// 10 consumed. Used to exercise the credit-drawdown reconcile paths.
function drawdownProbe(): UsageProbe {
  const creditQueue = [1000, 990];
  return {
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
        failure: null,
      };
    },
    async observeAccounting() {
      return { ok: accounting(5) };
    },
  };
}

// Adapters whose writer runs under a specific credential ref, so the run-end
// reconcile classifies its credit/overage signal off that ref.
function adaptersWithAuthRef(authRef: string) {
  return {
    ...defaultLoopInput().input.adapters,
    planner: makePlanner([buildPlan([{ title: "T1", intent: "Touch README", behaviorIds: ["B1"] }])]),
    writer: { ...makeWriter(["diff --git README\n+ok\n"]), authRef },
    checker: makeChecker([completeCheck]),
    auditor: makeAuditor([cleanAudit]),
  };
}

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
    failure: null,
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
    failure: null,
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
      return { ok: acct };
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

    // The run's cost rows are self-hosted (the fake adapter's ref), so the ccusage
    // figure is the NOTIONAL token-value of all the run's tokens — apportioned across
    // EVERY row into notional_cost_usd, summing to the $0.6 total. REAL spend
    // (cost_usd) stays NULL on the self-hosted rows (ccusage is never real spend for
    // a non-per_token credential — the apex-v19 fix), so costUpdates is empty.
    expect(pool.notionalUpdates).toHaveLength(pool.costInserts.length);
    const summedNotional = pool.notionalUpdates.reduce((sum, update) => sum + Number(update.notionalCostUsd), 0);
    expect(summedNotional).toBeCloseTo(0.6, 5);
    expect(pool.costUpdates).toHaveLength(0);
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
          failure: null,
        };
      },
      async observeAccounting() {
        return { ok: accounting(5) };
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

  it("apex v30: a BYOK run's post-task usage/cost accounting does NOT throw on an empty writer ref", async () => {
    // The v30 sequence: task.completed → usage.accounting.observed →
    // usage.window.observed → (historically) a crash when the accounting resolved
    // an empty platform metering ref. A BYOK run has NO managed capturer
    // (captureRealProviderCost is omitted), so the accounting must reconcile off the
    // BYOK credential it already has — and even an EMPTY writer authRef (the
    // no-credential edge) must complete the accounting, never throw an empty-ref
    // format error.
    const { input, events } = defaultLoopInput({
      usageProbe: drawdownProbe(),
      adapters: adaptersWithAuthRef(""),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("usage.accounting.observed");
    expect(names).toContain("usage.window.observed");
    // No managed capturer was wired (BYOK), so no real-provider capture failure and
    // no empty-ref crash surfaced as a cost event.
    expect(JSON.stringify(events.events)).not.toContain("invalid format");
  });

  it("cost PR-C: a credit drawdown with NO configured rate is NULL-and-loud, never a constant", async () => {
    // A Codex subscription credential genuinely draws down credits, but the loop is
    // given NO creditUsdRate (no config). Real spend must be recorded as unknown
    // (no cost update) and a loud cost.credit_rate_unknown event must fire — the old
    // $0.04 magic-constant fallback is gone.
    const { input, pool, events } = defaultLoopInput({
      usageProbe: drawdownProbe(),
      adapters: adaptersWithAuthRef("credential/codex/org/o1/default"),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    expect(pool.costUpdates).toHaveLength(0);
    const unknown = events.events.find((event) => event.eventType === "cost.credit_rate_unknown");
    expect(unknown).toBeDefined();
    const unknownPayload = unknown!.payload as { refKind: string; creditsConsumed: number };
    expect(unknownPayload.refKind).toBe("credential/codex");
    expect(unknownPayload.creditsConsumed).toBe(10);
  });

  it("cost PR-C: a configured per-credential rate prices the drawdown (no loud-unknown)", async () => {
    const { input, pool, events } = defaultLoopInput({
      usageProbe: drawdownProbe(),
      adapters: adaptersWithAuthRef("credential/codex/org/o1/default"),
      creditUsdRate: 0.07,
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // 10 credits × $0.07 = $0.70, apportioned with cost_basis='credits'.
    expect(pool.costUpdates.every((update) => update.basis === "credits")).toBe(true);
    const summed = pool.costUpdates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(0.7, 5);
    expect(events.events.map((event) => event.eventType)).not.toContain("cost.credit_rate_unknown");
  });

  it("§3.7f: two concurrent runs on ONE credential do NOT double-count the drawdown", async () => {
    // The credential's GLOBAL balance drew down 10 credits, but TWO runs share that
    // credential concurrently. Each run observes the SAME 10-credit global delta; the
    // fix divides by the concurrent-run count so each attributes HALF — the sum across
    // both runs equals the real 10-credit (not 20-credit) drawdown.
    const { input, pool } = defaultLoopInput({
      usageProbe: drawdownProbe(),
      adapters: adaptersWithAuthRef("credential/codex/org/o1/default"),
      creditUsdRate: 0.07,
    });
    pool.concurrentRunsOnCredential = 2;

    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // The run STAMPED its credential identity (the per-run dedup key) on `runs`.
    expect(pool.runsAuthRefStamps).toContainEqual(
      expect.objectContaining({ authRef: "credential/codex/org/o1/default" }),
    );
    // Attributed share = (10 credits / 2 concurrent runs) × $0.07 = $0.35, NOT $0.70.
    expect(pool.costUpdates.every((update) => update.basis === "credits")).toBe(true);
    const summed = pool.costUpdates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(0.35, 5);
  });

  it("§3.7f: a LONE run on a credential attributes the FULL drawdown (divisor 1, unchanged)", async () => {
    const { input, pool } = defaultLoopInput({
      usageProbe: drawdownProbe(),
      adapters: adaptersWithAuthRef("credential/codex/org/o1/default"),
      creditUsdRate: 0.07,
    });
    pool.concurrentRunsOnCredential = 1;

    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // 10 credits × $0.07 = $0.70 — the full delta, byte-identical to the pre-fix path.
    const summed = pool.costUpdates.reduce((sum, update) => sum + Number(update.costUsd), 0);
    expect(summed).toBeCloseTo(0.7, 5);
  });

  it("cost PR-C: a Claude subscription's overage is recorded NULL-and-loud (honest gap, never approximated)", async () => {
    // The Claude CLI subscription bundle reports no credit-balance delta locally, so
    // observeWindow yields a null creditsRemaining (no drawdown). The overage real
    // spend is UNKNOWN — a loud cost.overage_unobservable fires, ccusage stays
    // notional-only (no real cost update), and overage is NOT approximated.
    const { input, pool, events } = defaultLoopInput({
      usageProbe: fakeProbe(healthyWindow(), accounting(0.6)),
      adapters: adaptersWithAuthRef("credential/claude/org/o1/default"),
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    const overage = events.events.find((event) => event.eventType === "cost.overage_unobservable");
    expect(overage).toBeDefined();
    const overagePayload = overage!.payload as { provider: string; authoritativeSource: string };
    expect(overagePayload.provider).toBe("anthropic");
    expect(overagePayload.authoritativeSource).toBe("anthropic-admin-api-cost-report");
    // No REAL overage spend was invented — the ccusage figure stays notional only.
    expect(pool.costUpdates).toHaveLength(0);
  });

  it("cost PR-C: a non-subscription (self-hosted) credential emits NO overage gap event", async () => {
    const { input, events } = defaultLoopInput({
      usageProbe: fakeProbe(healthyWindow(), accounting(null)),
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(events.events.map((event) => event.eventType)).not.toContain("cost.overage_unobservable");
  });
});
