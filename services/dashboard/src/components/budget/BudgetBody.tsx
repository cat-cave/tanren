/**
 * Budget-halt operator panel body. Surfaces the enforced project ceiling the
 * DagWalker gates on: ceiling, period, REAL spend (`spentUsd` — the gated
 * figure), notional (API-equivalent, NOT gated), remaining headroom, and a
 * visible halt banner when `paused === true`.
 *
 * Config control: server-rendered form POSTs to `/budget` which proxies PUT to
 * the orchestrator. Org default is shown for context only (not edited here).
 * Uncomputable/missing → "—"; read failure → "unavailable" (never fake zeros).
 *
 * Fail-closed safety: the budget GET does not expose `failClosed`, but a pause
 * with no resolved ceiling means spend was NOT measured (backend placeholders
 * zeros). Those figures render "—", not `$0.00`.
 */

import type { BudgetPeriod, OrgBudgetView, ProjectBudgetView } from "../../api/budget.js";
import { budgetPeriodLabel, budgetUsd } from "./format.js";
import { BUDGET_SCREEN_CSS } from "./styles.js";

export type BudgetFlash = { kind: "ok"; message: string } | { kind: "err"; message: string } | undefined;

export interface BudgetBodyProps {
  /** Project budget observation, or `undefined` when the read failed. */
  projectBudget: ProjectBudgetView | undefined;
  /** Org default budget (context only), or `undefined` when the read failed. */
  orgBudget: OrgBudgetView | undefined;
  /** Explicit project id for the mutation form (scoped write). */
  projectId: string;
  projectName: string;
  noProject: boolean;
  /** Flash after a form POST proxy (saved / cleared / error). */
  flash?: BudgetFlash;
}

const PERIODS: BudgetPeriod[] = ["monthly", "quarterly", "annual", "total"];

interface StatCard {
  label: string;
  value: string;
  sub: string;
}

function isEmpty(value: string): boolean {
  return value === "—";
}

/**
 * Spend is uncomputable when the walker is fail-closed. The budget GET does not
 * expose `failClosed`, so recover it from the observation shape:
 *   - paused + null ceiling → unresolvable/unparseable (backend zero placeholders)
 *   - paused + ceiling set + spent < ceiling → unpriced_spend (true spend unknown;
 *     partial sum must not be painted as the gated total, especially $0.00)
 * A genuine ceiling-reached halt has spent ≥ ceiling and is NOT uncomputable.
 */
function isSpendUncomputable(b: ProjectBudgetView): boolean {
  if (!b.paused) return false;
  if (b.ceilingUsd === null) return true;
  return b.spentUsd < b.ceilingUsd;
}

/** Cards from a successful project-budget read. */
function spendCards(b: ProjectBudgetView): StatCard[] {
  const uncomputable = isSpendUncomputable(b);
  return [
    {
      label: "ceiling",
      value: budgetUsd(b.ceilingUsd),
      sub: `${budgetPeriodLabel(b.period)} period`,
    },
    {
      label: "real spend",
      value: uncomputable ? "—" : budgetUsd(b.spentUsd),
      sub: uncomputable ? "unmeasured · fail-closed safety pause" : "gated figure · cost_usd billed",
    },
    {
      label: "notional",
      value: uncomputable ? "—" : budgetUsd(b.notionalUsd),
      sub: uncomputable ? "unmeasured · fail-closed safety pause" : "API-equivalent · not gated",
    },
    {
      label: "remaining",
      value: uncomputable ? "—" : budgetUsd(b.remainingUsd),
      sub: uncomputable ? "headroom uncomputable while spend is unknown" : "headroom vs real spend",
    },
  ];
}

function OrgDefaultLine(props: { orgBudget: OrgBudgetView | undefined }) {
  const { orgBudget } = props;
  if (orgBudget === undefined) {
    return <div class="org-default">Org default budget: unavailable</div>;
  }
  const ceiling = budgetUsd(orgBudget.ceilingUsd);
  const period = budgetPeriodLabel(orgBudget.period);
  return (
    <div class="org-default">
      Org default budget: <b>{ceiling}</b> · {period}
      {orgBudget.ceilingUsd === null ? " (no org default — projects inherit unlimited until set)" : ""}
    </div>
  );
}

function ConfigForm(props: { projectBudget: ProjectBudgetView | undefined; projectId: string }) {
  const b = props.projectBudget;
  const defaultCeiling = b?.ceilingUsd === null || b?.ceilingUsd === undefined ? "" : String(b.ceilingUsd);
  const defaultPeriod: BudgetPeriod = b?.period ?? "monthly";
  return (
    <form class="budget-form" method="post" action="/budget">
      <input type="hidden" name="projectId" value={props.projectId} />
      <div class="form-row">
        <div class="field">
          <label for="ceilingUsd">project ceiling (USD)</label>
          <input
            id="ceilingUsd"
            name="ceilingUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 50"
            value={defaultCeiling}
          />
        </div>
        <div class="field">
          <label for="period">period</label>
          <select id="period" name="period">
            {PERIODS.map((p) => (
              <option value={p} selected={p === defaultPeriod}>
                {budgetPeriodLabel(p)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit" name="action" value="save">
          save ceiling
        </button>
        <button class="btn" type="submit" name="action" value="clear">
          clear project budget
        </button>
      </div>
      <div class="note">
        <b>↑ project-own budget.</b> Saving sets this project's ceiling (overrides the org default). Clearing removes
        the project budget so the org default / unlimited applies. The ceiling always gates <b>real spend</b>, never
        notional.
      </div>
    </form>
  );
}

function HaltBanner(props: { budget: ProjectBudgetView }) {
  const uncomputable = isSpendUncomputable(props.budget);
  return (
    <section class="halt-banner" role="alert">
      <span class="halt-title">halted on budget</span>
      <span class="halt-sub">
        {uncomputable
          ? "Fail-closed safety pause: true spend is unknown (unresolvable org, unparseable config, or unpriced spend rows). Figures are unmeasured — not zero. Fix pricing/config, then re-check; raising the ceiling does not invent missing spend facts."
          : "The DagWalker is paused because real spend has reached this project's ceiling. Raise or clear the ceiling to free headroom; a successful write re-wakes the walk when the gate loosens."}
      </span>
    </section>
  );
}

export function BudgetBody(props: BudgetBodyProps) {
  const { projectBudget, orgBudget, projectId, projectName, noProject, flash } = props;
  return (
    <>
      <style data-screen="budget" dangerouslySetInnerHTML={{ __html: BUDGET_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · budget · enforced ceiling · {projectName || "no project"}</div>
          <div class="page-title">budget &amp; spend gate</div>
        </div>
      </div>
      <div class="page-body">
        <div class="budget-screen">
          {noProject ? (
            <section class="panel">
              <div class="empty">
                No project visible yet. Onboard one to set a spend ceiling — once runs land, real spend and remaining
                headroom surface here from the orchestrator budget gate.
              </div>
            </section>
          ) : (
            <>
              {flash === undefined ? null : <div class={`flash ${flash.kind}`}>{flash.message}</div>}

              {projectBudget?.paused === true ? <HaltBanner budget={projectBudget} /> : null}

              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">enforced ceiling · real spend is the gated figure</div>
                  {projectBudget === undefined ? (
                    <div class="empty">Budget unavailable — the orchestrator read failed.</div>
                  ) : (
                    <>
                      <div class="budget-grid">
                        {spendCards(projectBudget).map((card) => (
                          <div class="budget-card">
                            <span class="label">{card.label}</span>
                            <span class={`value${isEmpty(card.value) ? " empty" : ""}`}>{card.value}</span>
                            <span class="sub">{card.sub}</span>
                          </div>
                        ))}
                      </div>
                      <div class="note">
                        <b>↑ real spend vs notional.</b> The ceiling always gates <b>real spend</b> (`spentUsd` — billed
                        cost). <b>Notional</b> is the API-equivalent estimate over the same period — surfaced so
                        subscription orgs see a non-zero figure; it is never the gated number.
                      </div>
                    </>
                  )}
                </div>
              </section>

              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">configure project ceiling</div>
                  <OrgDefaultLine orgBudget={orgBudget} />
                  <ConfigForm projectBudget={projectBudget} projectId={projectId} />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
