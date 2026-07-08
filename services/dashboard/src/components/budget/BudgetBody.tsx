/**
 * Budget-halt operator panel body. Surfaces the enforced project ceiling the
 * DagWalker gates on: ceiling, period, REAL spend (`spentUsd` — the gated
 * figure), notional (API-equivalent, NOT gated), remaining headroom, and a
 * visible halt banner when `paused === true`.
 *
 * Config control: server-rendered form POSTs to `/budget` which proxies PUT to
 * the orchestrator. Org default is shown for context only (not edited here).
 * Uncomputable/missing → "—"; read failure → "unavailable" (never fake zeros).
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

/** Cards from a successful project-budget read. */
function spendCards(b: ProjectBudgetView): StatCard[] {
  return [
    {
      label: "ceiling",
      value: budgetUsd(b.ceilingUsd),
      sub: `${budgetPeriodLabel(b.period)} period`,
    },
    {
      label: "real spend",
      value: budgetUsd(b.spentUsd),
      sub: "gated figure · cost_usd billed",
    },
    {
      label: "notional",
      value: budgetUsd(b.notionalUsd),
      sub: "API-equivalent · not gated",
    },
    {
      label: "remaining",
      value: budgetUsd(b.remainingUsd),
      sub: "headroom vs real spend",
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

function ConfigForm(props: { projectBudget: ProjectBudgetView | undefined }) {
  const b = props.projectBudget;
  const defaultCeiling = b?.ceilingUsd === null || b?.ceilingUsd === undefined ? "" : String(b.ceilingUsd);
  const defaultPeriod: BudgetPeriod = b?.period ?? "monthly";
  return (
    <form class="budget-form" method="post" action="/budget">
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

export function BudgetBody(props: BudgetBodyProps) {
  const { projectBudget, orgBudget, projectName, noProject, flash } = props;
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

              {projectBudget?.paused === true ? (
                <section class="halt-banner" role="alert">
                  <span class="halt-title">halted on budget</span>
                  <span class="halt-sub">
                    The DagWalker is paused on this project's budget. Raise or clear the ceiling to free headroom; a
                    successful write re-wakes the walk when the gate loosens.
                  </span>
                </section>
              ) : null}

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
                  <ConfigForm projectBudget={projectBudget} />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
