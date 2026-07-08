/**
 * Budget-halt route. Mounts GET + POST through the shell:
 *   GET  /budget — enforced ceiling, real spend, notional, remaining, pause banner
 *   POST /budget — form proxy that PUTs project budget to the orchestrator
 *
 * Reads project + org budget views; mutations go through the dashboard form POST
 * so the operator never calls the orchestrator directly. Mounted via ONE append
 * to SCREEN_MOUNTS + one nav row. Reuses loadShellContext + renderShell.
 */

import type { Context, Hono } from "hono";
import { BudgetClient } from "../../api/budgetClient.js";
import type { BudgetPeriod, OrgBudgetView, ProjectBudgetView } from "../../api/budget.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { BudgetBody, type BudgetFlash } from "../../components/budget/BudgetBody.js";
import { formField } from "../formField.js";

const PERIODS = new Set<BudgetPeriod>(["monthly", "quarterly", "annual", "total"]);

function clientFor(c: Context, deps: ShellDeps): BudgetClient {
  return new BudgetClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function parsePeriod(raw: string): BudgetPeriod | undefined {
  return PERIODS.has(raw as BudgetPeriod) ? (raw as BudgetPeriod) : undefined;
}

function flashFromQuery(c: Context): BudgetFlash {
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  if (ok === "saved") return { kind: "ok", message: "Project budget ceiling saved." };
  if (ok === "cleared") return { kind: "ok", message: "Project budget cleared — org default / unlimited applies." };
  if (err === "invalid") return { kind: "err", message: "Invalid ceiling — enter a non-negative number, or clear." };
  if (err === "save_failed") return { kind: "err", message: "Could not save budget — orchestrator write failed." };
  if (err === "no_project")
    return { kind: "err", message: "No project visible — onboard one before setting a budget." };
  return undefined;
}

export function mountBudgetScreen(app: Hono, deps: ShellDeps): void {
  app.get("/budget", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "budget" });
    const project = ctx.projects[0];

    let projectBudget: ProjectBudgetView | undefined;
    let orgBudget: OrgBudgetView | undefined;
    if (ctx.org !== undefined) {
      const client = clientFor(c, deps);
      if (project === undefined) {
        orgBudget = await client.getOrgBudget(ctx.org.id);
      } else {
        [orgBudget, projectBudget] = await Promise.all([
          client.getOrgBudget(ctx.org.id),
          client.getProjectBudget(ctx.org.id, project.projectId),
        ]);
      }
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · budget" },
      <BudgetBody
        projectBudget={projectBudget}
        orgBudget={orgBudget}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
        flash={flashFromQuery(c)}
      />,
    );
  });

  // Form POST proxy → orchestrator PUT. Clear sends ceilingUsd: null.
  app.post("/budget", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "budget" });
    const project = ctx.projects[0];
    if (ctx.org === undefined || project === undefined) {
      return c.redirect("/budget?err=no_project");
    }

    const form = await c.req.parseBody();
    const action = formField(form, "action", "save");
    const client = clientFor(c, deps);

    if (action === "clear") {
      const result = await client.putProjectBudget(ctx.org.id, project.projectId, { ceilingUsd: null });
      if (!result.ok) return c.redirect("/budget?err=save_failed");
      return c.redirect("/budget?ok=cleared");
    }

    const rawCeiling = formField(form, "ceilingUsd").trim();
    if (rawCeiling === "") {
      return c.redirect("/budget?err=invalid");
    }
    const ceilingUsd = Number(rawCeiling);
    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
      return c.redirect("/budget?err=invalid");
    }
    const period = parsePeriod(formField(form, "period", "monthly"));
    const result = await client.putProjectBudget(ctx.org.id, project.projectId, {
      ceilingUsd,
      period,
    });
    if (!result.ok) return c.redirect("/budget?err=save_failed");
    return c.redirect("/budget?ok=saved");
  });
}
