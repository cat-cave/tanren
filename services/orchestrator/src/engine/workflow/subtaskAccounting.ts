/**
 * subtaskAccounting — the usage-window preflight and run-end cost reconciliation
 * helpers for the subtask loop. Extracted from subtaskLoop.ts to keep that file
 * under the 500-line architecture cap. These read the provider usage probe,
 * emit usage.window/accounting events, and reconcile the run's marginal dollar
 * cost (credit drawdown wins, else ccusage). REAL SPEND IS A FACT: a real credit
 * drawdown is priced at a CONFIGURED per-credential rate or recorded NULL-and-loud
 * (never a magic constant), and a subscription whose overage is not locally
 * observable (Claude) records NULL-and-loud (never an approximation) — see
 * costs/creditRate.ts + costs/claudeOverage.ts.
 */
import { classifyOverageReachability, credentialSlugOf } from "../costs/index.js";
import { usageReadFailedPayload } from "../usage/index.js";
import type { UsageReadFailure } from "../usage/index.js";
import type { AppendEvent, SubtaskLoopInput, SubtaskLoopOutcome } from "./subtaskLoop.js";

// Emit the LOUD `usage.read_failed` event for a discriminated usage-probe read
// failure (timeout / SSH / nonzero-exit / malformed). This is the seam that keeps
// a FAILED read from silently becoming a normal zero-usage run: the probe returns
// `{ failed }` distinct from a clean-but-empty `null`, and only the failure path
// reaches here. Never throws (the loud event IS the surfacing).
async function emitUsageReadFailed(
  appendEvent: AppendEvent,
  failure: UsageReadFailure,
  plannerTaskId: string,
): Promise<void> {
  await appendEvent("usage.read_failed", usageReadFailedPayload(failure), plannerTaskId);
}

export interface CreditState {
  atStart: number | null;
}

// The run's resolved credential identity — the writer adapter's authRef. Prepaid-credit
// balances are GLOBAL to a credential, so this is the per-run dedup key that lets the
// run-end reconcile attribute only THIS run's share of a shared-credential drawdown.
function runAuthRef(input: SubtaskLoopInput): string {
  return input.adapters.writer.authRef;
}

// Stamp `runs.auth_ref` for this run (idempotent — the same value every time), so a
// CONCURRENT run on the SAME credential can be COUNTED at drawdown-measurement time.
// Best-effort + LOUD-but-non-fatal: a stamp failure must never fail the run (the
// reconcile then falls back to attributing the full delta — the prior behavior), but
// it is surfaced so the over-attribution risk is not silent. Runs org-scoped via
// `input.pool` (the worker's job-org-scoped loop client).
async function stampRunAuthRef(input: SubtaskLoopInput): Promise<void> {
  try {
    await input.pool.query(`UPDATE runs SET auth_ref = $2 WHERE run_id = $1 AND auth_ref IS DISTINCT FROM $2`, [
      input.context.runId,
      runAuthRef(input),
    ]);
  } catch (error) {
    console.error(
      `[subtask-accounting] failed to stamp runs.auth_ref for run ${input.context.runId}; ` +
        `concurrent-credential drawdown attribution falls back to the full delta (may over-count):`,
      error,
    );
  }
}

// Count the runs CONCURRENTLY ACTIVE on the SAME credential (auth_ref) right now —
// THIS run plus any other non-terminal run that has stamped the same auth_ref. The
// credential's GLOBAL drawdown is shared across exactly these runs, so dividing the
// observed delta by this count attributes only this run's share (the sum across the
// concurrent runs equals the real drawdown — no double-count). Floors at 1 (this run
// always counts). A query failure is LOUD and falls back to 1 (full delta — the prior
// behavior), never a silent miscount.
async function countConcurrentRunsOnCredential(input: SubtaskLoopInput): Promise<number> {
  try {
    const result = await input.pool.query<{ n: string }>(
      // THIS run always counts (run_id = $1), even if its status already flipped to a
      // terminal value before run-end accounting runs; plus any other still-active run
      // sharing the credential.
      `SELECT count(*)::text AS n FROM runs
        WHERE auth_ref = $2
          AND (run_id = $1 OR status NOT IN ('completed', 'failed', 'cancelled'))`,
      [input.context.runId, runAuthRef(input)],
    );
    const n = Number(result.rows[0]?.n ?? "1");
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch (error) {
    console.error(
      `[subtask-accounting] failed to count concurrent runs on credential for run ${input.context.runId}; ` +
        `attributing the FULL drawdown delta (may over-count a shared credential):`,
      error,
    );
    return 1;
  }
}

// checkWindowPreflight reads the live subscription-window state (codexbar) for
// the run's credential and escalates PROJECT_BRIEF §4.3 window pressure. It
// emits usage.window.observed for the live state and, when a window is at/over
// the pressure threshold, usage.window.pressure plus a window_exhausted
// outcome so the loop halts BEFORE dispatching a doomed planner call.
//
// DISCRIMINATED reads (no-silent-fallbacks): no probe wired → null (proceed); a
// CLEAN-but-empty read (usage null, no failure) → null (proceed, an allowed
// state); a FAILED read → emit the loud `usage.read_failed` and proceed WITHOUT
// inventing window pressure — the failure is surfaced, never conflated with an
// empty window. (A read failure does not BLOCK the planner — window pressure is
// the only escalation here — but it is no longer SILENT.)
export async function checkWindowPreflight(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  // The current loop index — narration only; the loop stamps the real `loopCount` onto
  // the returned outcome. Unused here beyond keeping the call-site signature stable.
  _loopIndex: number,
  creditState: CreditState,
): Promise<Omit<Extract<SubtaskLoopOutcome, { kind: "window_exhausted" }>, "loopCount"> | null> {
  if (input.usageProbe === undefined) {
    return null;
  }
  const { usage, pressure, failure } = await input.usageProbe.observeWindow();
  if (failure !== null) {
    // A FAILED read is LOUD, not a silent "no window pressure" — surface it.
    await emitUsageReadFailed(appendEvent, failure, plannerTaskId);
    return null;
  }
  // Capture the credit balance at the first observation that reports one; the
  // run-end drawdown against this baseline is the run's marginal dollar cost.
  //
  // §3.7f double-count fix: `creditsRemaining` is the credential's GLOBAL balance, so
  // two runs sharing one credential each see the same baseline + the same combined
  // drawdown. On the FIRST baseline capture we STAMP `runs.auth_ref` (the per-run dedup
  // key) so the run-end reconcile can COUNT the concurrent runs on the credential and
  // attribute only this run's share — the spend is no longer N×-counted.
  if (creditState.atStart === null && usage !== null && usage.creditsRemaining !== null) {
    creditState.atStart = usage.creditsRemaining;
    await stampRunAuthRef(input);
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
// Reconcile precedence: a positive credit drawdown is the true marginal spend for
// subscription-overage usage, so it wins — priced at the CONFIGURED per-credential
// rate, or recorded NULL-and-loud (`cost.credit_rate_unknown`) when no rate is
// configured. Otherwise, a subscription whose overage is not locally observable
// (Claude) records the overage as a NULL-and-loud honest gap
// (`cost.overage_unobservable`), and a positive ccusage cost applies. Either
// reconcile apportions the run total by token share.
export async function observeRunAccounting(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  creditState: CreditState,
): Promise<void> {
  if (input.usageProbe === undefined) {
    return;
  }
  const accountingRead = await input.usageProbe.observeAccounting();
  // DISCRIMINATED: a FAILED ccusage read is LOUD — emit usage.read_failed so the
  // run's end-of-run reconcile gap is visible, NEVER silently a zero-cost reconcile.
  if ("failed" in accountingRead) {
    await emitUsageReadFailed(appendEvent, accountingRead.failed, plannerTaskId);
  }
  // A clean read is `{ ok: <accounting> | null }`; null is legitimate-empty (quiet).
  const accounting = "failed" in accountingRead ? null : accountingRead.ok;
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

  const observedDrawdown = await readEndingCreditDrawdown(input, appendEvent, plannerTaskId, creditState);
  if (observedDrawdown !== null && observedDrawdown > 0) {
    // §3.7f: the observed delta is the credential's GLOBAL drawdown, shared across
    // every run concurrently active on that credential. Divide by the concurrent-run
    // count so THIS run is attributed only its share (the sum across the concurrent
    // runs == the real drawdown — no double-count). With one run, the divisor is 1
    // and this is byte-identical to before.
    const concurrentRuns = await countConcurrentRunsOnCredential(input);
    const creditsConsumed = observedDrawdown / concurrentRuns;
    // A REAL credit drawdown — the subscription-overage marginal spend. Price it
    // at the CONFIGURED per-credential rate, else record NULL-and-loud (never the
    // old magic constant).
    await reconcileCreditDrawdown(input, appendEvent, plannerTaskId, creditsConsumed);
    return;
  }
  // No credit drawdown observed. If the run's subscription is one whose overage is
  // NOT observable on the local path (Claude), the overage real spend is an HONEST
  // NULL gap — surface it loudly rather than silently treating overage as $0.
  await flagUnobservableOverage(input, appendEvent, plannerTaskId);
  if (accounting !== null && accounting.costUsd !== null) {
    await input.recorder.reconcileRunCostFromCcusage(input.context.runId, accounting.costUsd);
  }
}

// reconcileCreditDrawdown prices a positive real credit drawdown at the run's
// CONFIGURED per-credential credit→USD rate. The rate is resolved upstream
// (runExecutionContext) and threaded on `input.creditUsdRate`. REAL SPEND IS A
// FACT: a missing rate for a credential that genuinely drew down is a LOUD unknown
// (`cost.credit_rate_unknown`) and the run records NULL real spend — NEVER a
// fallback constant. A configured rate runs the drawdown→USD apportion as before.
async function reconcileCreditDrawdown(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
  creditsConsumed: number,
): Promise<void> {
  if (input.creditUsdRate === undefined) {
    const authRef = input.adapters.writer.authRef;
    await appendEvent(
      "cost.credit_rate_unknown",
      {
        refKind: credentialSlugOf(authRef),
        creditsConsumed,
        reason:
          "credential drew down prepaid credits but no per-credential credit→USD rate is configured (config.creditRates); real spend recorded as unknown",
      },
      plannerTaskId,
    );
    return;
  }
  await input.recorder.reconcileRunCostFromCredits(input.context.runId, creditsConsumed, input.creditUsdRate);
}

// flagUnobservableOverage surfaces the HONEST Claude-overage gap: a subscription
// whose "extra usage" overage real dollar spend is not reachable from the local CLI
// path. We do NOT approximate it from the local estimate — the overage real spend
// stays NULL and a `cost.overage_unobservable` event names the gap + the
// authoritative source that WOULD carry the figure. A no-op for every other
// credential (codex credit-delta, per-token, self-hosted, absent).
async function flagUnobservableOverage(
  input: SubtaskLoopInput,
  appendEvent: AppendEvent,
  plannerTaskId: string,
): Promise<void> {
  const authRef = input.adapters.writer.authRef;
  const reachability = classifyOverageReachability(authRef);
  if (reachability.kind !== "unobservable_local" || reachability.authoritativeSource === null) {
    return;
  }
  await appendEvent(
    "cost.overage_unobservable",
    {
      provider: reachability.provider,
      refKind: credentialSlugOf(authRef),
      authoritativeSource: reachability.authoritativeSource,
      reason:
        "subscription overage (extra usage) real spend is not reachable from the local CLI path; recorded as unknown rather than approximated",
    },
    plannerTaskId,
  );
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
  const { usage, failure } = await input.usageProbe.observeWindow();
  if (failure !== null) {
    // A FAILED ending-window read is LOUD — the drawdown is unmeasurable, not $0.
    await emitUsageReadFailed(appendEvent, failure, plannerTaskId);
    return null;
  }
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
