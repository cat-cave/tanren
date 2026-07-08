/**
 * Budget-halt route. Mounts GET + POST through the shell:
 *   GET  /budget — enforced ceiling, real spend, notional, remaining, pause banner
 *   POST /budget — form proxy that PUTs project budget to the orchestrator
 *
 * Project scope: `?projectId=` (GET) or hidden form `projectId` (POST), resolved
 * against the org's project list (never an unvalidated id). Defaults to the first
 * visible project when omitted (same convention as DORA / merge-queue). Mutations
 * always carry the explicit project id from the form.
 *
 * Reads project + org budget views; mutations go through the dashboard form POST
 * so the operator never calls the orchestrator directly. Mounted via ONE append
 * to SCREEN_MOUNTS + one nav row. Reuses loadShellContext + renderShell.
 */

import type { Context, Hono } from "hono";
import { BudgetClient } from "../../api/budgetClient.js";
import type { BudgetPeriod, OrgBudgetView, ProjectBudgetView } from "../../api/budget.js";
import type { ProjectSummary } from "../../api/types.js";
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

/**
 * Resolve the active project from an explicit id against the org-visible list.
 * Unknown ids fall back to the first visible project (never trust a bare id).
 */
function resolveProject(projects: ProjectSummary[], projectId: string | undefined): ProjectSummary | undefined {
  if (projectId !== undefined && projectId !== "") {
    const match = projects.find((p) => p.projectId === projectId);
    if (match !== undefined) return match;
  }
  return projects[0];
}

function flashFromQuery(c: Context): BudgetFlash {
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  if (ok === "saved") return { kind: "ok", message: "Project budget ceiling saved." };
  if (ok === "cleared") return { kind: "ok", message: "Project budget cleared — org default / unlimited applies." };
  if (err === "invalid") {
    return { kind: "err", message: "Invalid ceiling or period — enter a non-negative number and a valid period." };
  }
  if (err === "save_failed") return { kind: "err", message: "Could not save budget — orchestrator write failed." };
  if (err === "no_project") {
    return { kind: "err", message: "No project visible — onboard one before setting a budget." };
  }
  return undefined;
}

function redirectBudget(projectId: string, qs: string): string {
  return `/budget?projectId=${encodeURIComponent(projectId)}&${qs}`;
}

export function mountBudgetScreen(app: Hono, deps: ShellDeps): void {
  app.get("/budget", async (c: Context) => {
    const requestedId = c.req.query("projectId");
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "budget",
      projectId: requestedId,
    });
    const project = resolveProject(ctx.projects, requestedId);

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
        projectId={project?.projectId ?? ""}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
        flash={flashFromQuery(c)}
      />,
    );
  });

  // Form POST proxy → orchestrator PUT. Clear sends ceilingUsd: null.
  // Project id MUST be present on the form and resolve against the org list —
  // never fall back to projects[0] on a write (unscoped mutation).
  app.post("/budget", async (c: Context) => {
    const form = await c.req.parseBody();
    const formProjectId = formField(form, "projectId").trim();
    if (formProjectId === "") {
      return c.redirect("/budget?err=no_project");
    }
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "budget",
      projectId: formProjectId,
    });
    const project = resolveProject(ctx.projects, formProjectId);
    if (ctx.org === undefined || project === undefined || project.projectId !== formProjectId) {
      return c.redirect("/budget?err=no_project");
    }

    const action = formField(form, "action", "save");
    const client = clientFor(c, deps);
    const pid = project.projectId;

    if (action === "clear") {
      const result = await client.putProjectBudget(ctx.org.id, pid, { ceilingUsd: null });
      if (!result.ok) return c.redirect(redirectBudget(pid, "err=save_failed"));
      return c.redirect(redirectBudget(pid, "ok=cleared"));
    }

    const rawCeiling = formField(form, "ceilingUsd").trim();
    if (rawCeiling === "") {
      return c.redirect(redirectBudget(pid, "err=invalid"));
    }
    const ceilingUsd = Number(rawCeiling);
    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
      return c.redirect(redirectBudget(pid, "err=invalid"));
    }
    const period = parsePeriod(formField(form, "period"));
    if (period === undefined) {
      return c.redirect(redirectBudget(pid, "err=invalid"));
    }
    const result = await client.putProjectBudget(ctx.org.id, pid, {
      ceilingUsd,
      period,
    });
    if (!result.ok) return c.redirect(redirectBudget(pid, "err=save_failed"));
    return c.redirect(redirectBudget(pid, "ok=saved"));
  });
}
