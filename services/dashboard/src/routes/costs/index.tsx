/**
 * history & costs routes. Mounts THREE GETs through the shell:
 *   GET /costs            — org-level cost dashboard (overrides the shell's
 *                           placeholder for the `costs` sidenav row)
 *   GET /costs/export.csv — provider-breakdown CSV export
 *   GET /history          — prior-run history list (project-scoped per)
 *
 * The costs dashboard aggregates records across every run in every
 * project the operator can see: it lists runs (`/runs`) then walks each
 * run's `/costs` page. The run list is the same read API the history list uses.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts. Reuses
 * loadShellContext + renderShell; never touches the chrome.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { CostRecord, RunListItem } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import { observeMetrics, projectBurn, summarizeCosts } from "../../components/costs/aggregate.js";
import { buildHeatmap } from "../../components/costs/heatmap.js";
import { CostsBody } from "../../components/costs/CostsBody.js";
import { HistoryBody } from "../../components/costs/HistoryBody.js";

const VALID_RANGES = new Set(["7d", "30d", "90d", "all"]);

/** Days of lookback for a range pill; "all" → undefined (no cutoff). */
function rangeDays(range: string): number | undefined {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return undefined;
}

/** Fetch every cost record across every project's runs the operator can see. */
async function gatherCosts(
  client: OrchestratorClient,
  orgId: string,
  projects: { projectId: string }[],
): Promise<{ records: CostRecord[]; runs: RunListItem[] }> {
  const records: CostRecord[] = [];
  const runs: RunListItem[] = [];
  for (const project of projects) {
    const projectRuns = await client.listRuns(orgId, project.projectId);
    runs.push(...projectRuns);
    for (const run of projectRuns) {
      const runCosts = await client.listRunCosts(orgId, project.projectId, run.runId);
      records.push(...runCosts);
    }
  }
  return { records, runs };
}

/** Apply the date-range cutoff to records (by recordedAt) + runs (by startedAt). */
function withinRange<T extends { recordedAt?: string; startedAt?: string }>(items: T[], range: string, now: Date): T[] {
  const days = rangeDays(range);
  if (days === undefined) return items;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const stamp = item.recordedAt ?? item.startedAt;
    if (stamp === undefined) return true;
    const t = new Date(stamp).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });
}

export function mountCostsScreen(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // GET /costs — org-level cost dashboard
  // -------------------------------------------------------------------------
  app.get("/costs", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
    const rawRange = c.req.query("range") ?? "30d";
    const range = VALID_RANGES.has(rawRange) ? rawRange : "30d";
    const now = new Date();

    let records: CostRecord[] = [];
    let runs: RunListItem[] = [];
    // The heatmap spans its own fixed 30-day window, so it reads the full
    // gathered record set — never the range-filtered slice the pills control.
    let allRecords: CostRecord[] = [];
    if (ctx.org !== undefined) {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const gathered = await gatherCosts(client, ctx.org.id, ctx.projects);
      allRecords = gathered.records;
      records = withinRange(gathered.records, range, now);
      runs = withinRange(gathered.runs, range, now);
    }

    const summary = summarizeCosts(records);
    const burn = projectBurn(records, { now });
    const metrics = observeMetrics(runs, summary.totalUsd);
    const heatmap = buildHeatmap(allRecords, { now });

    return renderCostsShell(c, ctx, {
      summary,
      burn,
      metrics,
      heatmap,
      range,
      orgLogin: ctx.org?.login ?? "",
    });
  });

  // -------------------------------------------------------------------------
  // GET /costs/export.csv — provider-breakdown CSV (acceptance: export-csv)
  // -------------------------------------------------------------------------
  app.get("/costs/export.csv", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
    let records: CostRecord[] = [];
    if (ctx.org !== undefined) {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const gathered = await gatherCosts(client, ctx.org.id, ctx.projects);
      records = gathered.records;
    }
    const summary = summarizeCosts(records);
    const header = "cli,model,provider,billing_mode,cost_basis,runs,total_tokens,cost_usd,share";
    const lines = summary.providers.map((row) =>
      [
        csv(row.cli),
        csv(row.model),
        csv(row.provider),
        row.billingMode,
        // The REAL cost source for this row; never a fabricated placeholder.
        row.costBasis,
        row.runs,
        row.totalTokens,
        row.priced ? row.costUsd.toFixed(6) : "",
        row.share.toFixed(4),
      ].join(","),
    );
    const body = [header, ...lines].join("\n");
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="tanren-costs.csv"');
    return c.body(body);
  });

  // -------------------------------------------------------------------------
  // GET /history — prior-run history list (project-scoped per)
  // -------------------------------------------------------------------------
  app.get("/history", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
    const status = c.req.query("status") ?? "";
    const requestedProject = c.req.query("projectId");
    const project = ctx.projects.find((p) => p.projectId === requestedProject) ?? ctx.projects[0];

    let runs: RunListItem[] = [];
    if (ctx.org !== undefined && project !== undefined) {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      runs = await client.listRuns(ctx.org.id, project.projectId, { status });
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · run history" },
      <HistoryBody
        runs={runs}
        status={status}
        orgId={ctx.org?.id ?? ""}
        orgLogin={ctx.org?.login ?? ""}
        projectId={project?.projectId ?? ""}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
      />,
    );
  });
}

function csv(value: string): string {
  if (/[",\n]/u.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function renderCostsShell(
  c: Context,
  ctx: ShellContext,
  props: Parameters<typeof CostsBody>[0],
): Response | Promise<Response> {
  return renderShell(c, ctx, { title: "tanren · costs" }, <CostsBody {...props} />);
}
