/**
 * Budget surface response types. Own module (not the shared `types.ts`) so the
 * surface owns its contract and the shared type barrel stays under the 500-line
 * cap. Mirrors the orchestrator budget views:
 *   GET/PUT .../projects/:projectId/budget → ProjectBudgetView
 *   GET/PUT .../orgs/:orgId/budget         → OrgBudgetView
 *
 * Vocabulary (doctrine): `spentUsd` is REAL money out the door (the figure the
 * ceiling ALWAYS gates). `notionalUsd` is the API-equivalent estimate — NOT
 * spend, NOT gated. Null ceilings / remaining headroom render "—", never a
 * fabricated zero; a failed read yields `undefined` so the UI shows "unavailable".
 */

export type BudgetPeriod = "monthly" | "quarterly" | "annual" | "total";

/** Body for PUT project (or org) budget. `ceilingUsd: null` clears. */
export interface BudgetPutBody {
  ceilingUsd: number | null;
  period?: BudgetPeriod;
}

/**
 * Per-project budget observation (`GET/PUT .../projects/:id/budget`).
 * The resolved ceiling (project-over-org), real spend, notional, headroom, and
 * whether the walker is paused on budget.
 */
/** Fail-closed safety reason from the budget gate (null when open / ceiling-reached). */
export type BudgetFailClosedReason = "unpriced_spend" | "unparseable_config" | "unresolvable_project_org";

export interface BudgetPauseObservation {
  eventType: "dag.budget.paused";
  /** Eligible ready specs stopped by the project-level walker pause. */
  readyHeldBack: number;
  /** ISO timestamp of the durable event observation. */
  observedAt: string;
}

export interface ProjectBudgetView {
  ceilingUsd: number | null;
  period: BudgetPeriod;
  /** REAL spend over the period — the gated figure. */
  spentUsd: number;
  /** Notional / API-equivalent value — NOT spend, NOT gated. */
  notionalUsd: number;
  /** Headroom against real spend; null when there is no ceiling. */
  remainingUsd: number | null;
  /** True when the walker is halted on budget (or fail-closed safety pause). */
  paused: boolean;
  /** Latest project-level walker proof while the gate is active; null until emitted. */
  pauseObservation: BudgetPauseObservation | null;
  /**
   * When set, true spend is untrusted — do not paint spent/notional as measured
   * figures (especially not $0.00 placeholders). Null on genuine ceiling-reached
   * or when the gate is open. Optional for older payloads.
   */
  failClosed?: BudgetFailClosedReason | null;
}

/** Org-level default budget (`GET/PUT .../orgs/:id/budget`). No spend sum. */
export interface OrgBudgetView {
  ceilingUsd: number | null;
  period: BudgetPeriod;
}
