// BUDGET-SAFETY (M6): the run-setup budget preflight. A configured DOLLAR ceiling
// is only meaningful against a credential that can PRODUCE dollars. A subscription
// (codex/ChatGPT) or self-hosted credential has NO per-call dollar basis — it accrues
// cost_usd only when a usage probe wires the ccusage/credit-drawdown reconcile at
// run end (subtaskAccounting.observeRunAccounting). So a project that sets a
// `ceilingUsd` against such a credential WITH NO usage probe has a STRUCTURALLY
// UNREACHABLE ceiling: the run accrues zero dollars, the budget sum stays $0, and
// the gate never fires. That is a silent safety hole — surface it LOUDLY rather than
// let a dollar ceiling be silently configured against a credential that can never
// produce dollars.
import type { BudgetGate } from "../contracts/dagWalker.js";
import { classifyAuthRef, refKindOf } from "../costs/sources.js";
import type { AppendEvent } from "./subtaskLoop.js";

/**
 * Raised when a run is set up with a configured dollar ceiling but a credential
 * that can never produce dollars and no usage probe to reconcile real cost — the
 * ceiling is structurally unreachable, so the run FAILS CLOSED at setup rather than
 * spend under a ceiling that can never fire. Carries the secret-free ref KIND only.
 */
export class UnreachableBudgetCeilingError extends Error {
  readonly refKind: string;
  readonly billingMode: string;
  constructor(refKind: string, billingMode: string) {
    super(
      `configured dollar ceiling is unreachable for credential kind '${refKind}' (billing_mode=${billingMode}): ` +
        `a subscription/self-hosted credential accrues no per-call dollars and no usage probe is wired to reconcile ` +
        `real cost, so the ceiling can never fire — wire a usage probe or remove the dollar ceiling`,
    );
    this.name = "UnreachableBudgetCeilingError";
    this.refKind = refKind;
    this.billingMode = billingMode;
  }
}

export interface BudgetPreflightInput {
  /** The configured dollar ceiling, or undefined when no budget is set (unlimited). */
  ceilingUsd: number | undefined;
  /** The run's PRIMARY credential ref (the writer's authRef). */
  authRef: string;
  /** Whether a usage probe is wired for this run (reconciles real subscription cost). */
  hasUsageProbe: boolean;
}

/**
 * Run the M6 preflight. When a dollar ceiling is configured AND the run's credential
 * is subscription/self-hosted (no per-call dollar basis) AND no usage probe is wired,
 * emit `cost.ceiling_unreachable` (secret-free, names the ref KIND only) and throw
 * {@link UnreachableBudgetCeilingError} so the run fails closed at setup. Every other
 * combination (no ceiling, a per-token credential, or a usage probe present) is a
 * no-op — the run proceeds normally.
 */
export async function assertBudgetCeilingReachable(
  input: BudgetPreflightInput,
  appendEvent: AppendEvent,
): Promise<void> {
  // No ceiling configured ⇒ nothing to enforce (unlimited, today's behavior).
  if (input.ceilingUsd === undefined) {
    return;
  }
  // A usage probe reconciles ccusage/credit-drawdown dollars at run end, so a
  // subscription credential CAN accrue cost — the ceiling is reachable.
  if (input.hasUsageProbe) {
    return;
  }
  const classification = classifyAuthRef(input.authRef);
  // Only subscription / self-hosted credentials have NO per-call dollar basis. A
  // per_token credential prices every call from the provider table (reachable); an
  // unrecognized ref is handled separately (C1: cost.unattributed + fail-closed gate).
  if (classification.billingMode !== "subscription" && classification.billingMode !== "self_hosted") {
    return;
  }
  const refKind = refKindOf(input.authRef);
  await appendEvent("cost.ceiling_unreachable", {
    refKind,
    billingMode: classification.billingMode,
    ceilingUsd: input.ceilingUsd,
    reason:
      "a configured dollar ceiling cannot fire against a subscription/self-hosted credential with no usage probe (no per-call dollar basis)",
  });
  throw new UnreachableBudgetCeilingError(refKind, classification.billingMode);
}

/**
 * The production M6 wiring the run-setup path calls: resolve the project's
 * configured ceiling (via the org-scoped {@link BudgetGate} seam) and run the
 * reachability assert against the run's primary credential + whether a usage probe
 * is wired. Throws {@link UnreachableBudgetCeilingError} (after a loud
 * `cost.ceiling_unreachable` event) when the ceiling is structurally unreachable; a
 * no-op otherwise. Kept here so plannerRun.ts threads it in one call.
 */
export async function runBudgetCeilingPreflight(
  budgetGate: BudgetGate,
  projectId: string,
  authRef: string,
  hasUsageProbe: boolean,
  appendEvent: AppendEvent,
): Promise<void> {
  const budget = await budgetGate.resolveBudget(projectId);
  await assertBudgetCeilingReachable({ ceilingUsd: budget.ceilingUsd, authRef, hasUsageProbe }, appendEvent);
}
