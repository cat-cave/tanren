/**
 * subtaskAccounting — the usage-window preflight and run-end cost reconciliation
 * helpers for the subtask loop. Extracted from subtaskLoop.ts to keep that file
 * under the 500-line architecture cap. These read the provider usage probe,
 * emit usage.window/accounting events, and reconcile the run's marginal dollar
 * cost (credit drawdown wins, else ccusage, else per-call provider pricing).
 */
import { DEFAULT_CREDIT_USD_RATE } from "../costs/index.js";
import type { AppendEvent, SubtaskLoopInput, SubtaskLoopOutcome } from "./subtaskLoop.js";

export interface CreditState {
  atStart: number | null;
}

// checkWindowPreflight reads the live subscription-window state (codexbar) for
// the run's credential and escalates PROJECT_BRIEF §4.3 window pressure. It
// emits usage.window.observed for the live state and, when a window is at/over
// the pressure threshold, usage.window.pressure plus a window_exhausted
// outcome so the loop halts BEFORE dispatching a doomed planner call. No probe
// (or no data) → returns null (proceed normally).
export async function checkWindowPreflight(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  plannerRerunCount: number,
  creditState: CreditState,
): Promise<Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }> | null> {
  if (input.usageProbe === undefined) {
    return null;
  }
  const { usage, pressure } = await input.usageProbe.observeWindow();
  // Capture the credit balance at the first observation that reports one; the
  // run-end drawdown against this baseline is the run's marginal dollar cost.
  if (creditState.atStart === null && usage !== null && usage.creditsRemaining !== null) {
    creditState.atStart = usage.creditsRemaining;
  }
  if (usage !== null) {
    await appendEvent(
      "usage.window.observed",
      {
        provider: usage.provider,
        windows: usage.windows.map((window) => ({
          slot: window.slot,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          windowMinutes: window.windowMinutes,
          resetDescription: window.resetDescription,
        })),
        creditsRemaining: usage.creditsRemaining,
        source: usage.source,
        capturedAt: usage.capturedAt,
      },
      plannerTaskId,
    );
  }
  if (pressure === null) {
    return null;
  }
  const provider = usage?.provider ?? "unknown";
  await appendEvent(
    "usage.window.pressure",
    {
      provider,
      slot: pressure.slot,
      usedPercent: pressure.usedPercent,
      resetsAt: pressure.resetsAt,
    },
    plannerTaskId,
  );
  return {
    kind: "window_exhausted",
    plannerRerunCount,
    provider,
    slot: pressure.slot,
    usedPercent: pressure.usedPercent,
    resetsAt: pressure.resetsAt,
  };
}

// observeRunAccounting captures the run's real cost at the end. It reads:
//   1. ccusage token accounting (emits usage.accounting.observed), and
//   2. a final window observation (emits usage.window.observed) to read the
//      ending credit balance.
// Reconcile precedence: a positive credit drawdown is the true marginal spend
// for subscription-overage usage, so it wins; otherwise a positive ccusage
// cost applies; otherwise the per-call rows keep their honest provider_pricing
// / NULL basis. Either reconcile apportions the run total by token share.
export async function observeRunAccounting(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  creditState: CreditState,
): Promise<void> {
  if (input.usageProbe === undefined) {
    return;
  }
  const accounting = await input.usageProbe.observeAccounting();
  if (accounting !== null) {
    await appendEvent(
      "usage.accounting.observed",
      {
        cli: accounting.cli,
        totals: accounting.totals,
        costUsd: accounting.costUsd,
        capturedAt: accounting.capturedAt,
      },
      plannerTaskId,
    );
  }

  const creditsConsumed = await readEndingCreditDrawdown(input, appendEvent, plannerTaskId, creditState);
  if (creditsConsumed !== null && creditsConsumed > 0) {
    await input.recorder.reconcileRunCostFromCredits(
      input.context.runId,
      creditsConsumed,
      input.creditUsdRate ?? DEFAULT_CREDIT_USD_RATE,
    );
    return;
  }
  if (accounting !== null && accounting.costUsd !== null) {
    await input.recorder.reconcileRunCostFromCcusage(input.context.runId, accounting.costUsd);
  }
}

// readEndingCreditDrawdown does a final window observation, emits it, and
// returns (creditsAtStart - creditsAtEnd) when both are known, else null.
// Credit balances update asynchronously provider-side, so this is best-effort
// and may undercount a just-completed call's drawdown.
async function readEndingCreditDrawdown(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  creditState: CreditState,
): Promise<number | null> {
  if (input.usageProbe === undefined || creditState.atStart === null) {
    return null;
  }
  const { usage } = await input.usageProbe.observeWindow();
  if (usage === null) {
    return null;
  }
  await appendEvent(
    "usage.window.observed",
    {
      provider: usage.provider,
      windows: usage.windows.map((window) => ({
        slot: window.slot,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        windowMinutes: window.windowMinutes,
        resetDescription: window.resetDescription,
      })),
      creditsRemaining: usage.creditsRemaining,
      source: usage.source,
      capturedAt: usage.capturedAt,
    },
    plannerTaskId,
  );
  if (usage.creditsRemaining === null) {
    return null;
  }
  return creditState.atStart - usage.creditsRemaining;
}
