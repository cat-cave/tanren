/**
 * history & costs routes. Mounts THREE GETs through the shell:
 *   GET /costs            — org-level cost dashboard (overrides the shell's
 *                           placeholder for the `costs` sidenav row)
 *   GET /costs/export.csv — provider-breakdown CSV export
 *   GET /history          — prior-run history list (project-scoped per)
 *
 * The costs dashboard and CSV export each consume one org-scoped cost read
 * model (`GET /orgs/:orgId/costs`). The history list remains project-scoped.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts. Reuses
 * loadShellContext + renderShell; never touches the chrome.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient, type GetOrgCostsResult } from "../../api/orchestrator.js";
import type { CostRecord, RunListItem } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import { observeMetrics, projectBurn, summarizeCosts } from "../../components/costs/aggregate.js";
import { buildHeatmap } from "../../components/costs/heatmap.js";
import type { MonetaryCoverage } from "../../components/costs/coverage.js";
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
    let availability: Parameters<typeof CostsBody>[0]["availability"] = {
      kind: "unavailable",
      message: "no active organization could be resolved",
    };
    if (ctx.org === undefined) {
      c.status(503);
    } else {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const readModel = await client.getOrgCosts(ctx.org.id);
      if (readModel.kind === "ok") {
        availability = { kind: "available" };
        allRecords = readModel.data.costs;
        records = withinRange(readModel.data.costs, range, now);
        runs = withinRange(readModel.data.runs, range, now);
      } else {
        c.status(costsFailureStatus(readModel));
        availability = { kind: "unavailable", message: costsFailureMessage(readModel) };
      }
    }

    const summary = summarizeCosts(records);
    const burn = projectBurn(records, { now });
    const metrics = observeMetrics(runs, summary.realCoverage.kind === "known" ? summary.totalUsd : null);
    const heatmap = buildHeatmap(allRecords, { now });

    return renderCostsShell(c, ctx, {
      summary,
      burn,
      metrics,
      heatmap,
      availability,
      range,
      orgLogin: ctx.org?.login ?? "",
    });
  });

  // -------------------------------------------------------------------------
  // GET /costs/export.csv — provider-breakdown CSV (acceptance: export-csv)
  // -------------------------------------------------------------------------
  app.get("/costs/export.csv", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
    if (ctx.org === undefined) return c.json({ error: "costs_unavailable", reason: "no_active_org" }, 503);
    const client = new OrchestratorClient({
      orchestratorUrl: deps.orchestratorUrl,
      cookieHeader: c.req.header("cookie"),
    });
    const readModel = await client.getOrgCosts(ctx.org.id);
    if (readModel.kind !== "ok") {
      return c.json(
        {
          error: readModel.kind === "auth" ? "costs_auth_failed" : "costs_unavailable",
          reason: failureReason(readModel),
        },
        costsFailureStatus(readModel),
      );
    }
    const records = readModel.data.costs;
    const summary = summarizeCosts(records);
    const header =
      "cli,model,provider,billing_mode,cost_basis,runs,total_tokens,cost_state,cost_usd,notional_state,notional_cost_usd,share";
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
        // State comes ONLY from the row's explicit coverage — never inferred
        // from `knownUsd > 0` (a partial known-zero is still partial, not unknown).
        coverageState(row.realCoverage),
        // The known subtotal is emitted for known AND partial (even exactly 0);
        // only an all-unknown row leaves the value blank.
        coverageValue(row.realCoverage),
        coverageState(row.notionalCoverage),
        coverageValue(row.notionalCoverage),
        // Honest share: only when the global real total is known AND positive
        // AND this row is fully known. A zero denominator is undefined, so a
        // fully-known $0 total blanks the share rather than emitting 100%.
        summary.realCoverage.kind === "known" && row.realCoverage.kind === "known" && summary.totalUsd > 0
          ? row.share.toFixed(4)
          : "",
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
    let runsAvailable = true;
    if (ctx.org !== undefined && project !== undefined) {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const runsMaybe = await client.listRunsMaybe(ctx.org.id, project.projectId, { status });
      runs = runsMaybe ?? [];
      runsAvailable = runsMaybe !== undefined;
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · run history" },
      <HistoryBody
        runs={runs}
        runsAvailable={runsAvailable}
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
  const guarded = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  if (/[",\r\n]/u.test(guarded)) return `"${guarded.replaceAll('"', '""')}"`;
  return guarded;
}

/**
 * State label derived ONLY from explicit coverage — known (all priced),
 * partial (some priced), or unknown/empty (none priced). A partial known-zero
 * stays `partial`; it is never downgraded to `unknown` by a zero subtotal.
 */
function coverageState(coverage: MonetaryCoverage): "known" | "partial" | "unknown" {
  if (coverage.kind === "known") return "known";
  if (coverage.kind === "partial") return "partial";
  return "unknown";
}

/**
 * The known subtotal for known AND partial coverage (formatted to 6dp, including
 * exactly `0.000000`); blank only when coverage carries no known figure (all
 * unknown / empty) — so a spreadsheet never shows a fabricated zero spend.
 */
function coverageValue(coverage: MonetaryCoverage): string {
  return coverage.knownUsd === null ? "" : coverage.knownUsd.toFixed(6);
}

function failureReason(result: Exclude<GetOrgCostsResult, { kind: "ok" }>): string {
  return result.kind === "auth" ? "auth" : result.reason;
}

function costsFailureStatus(result: Exclude<GetOrgCostsResult, { kind: "ok" }>): 401 | 403 | 502 | 503 {
  if (result.kind === "auth") return result.status;
  return result.reason === "malformed" ? 502 : 503;
}

function costsFailureMessage(result: Exclude<GetOrgCostsResult, { kind: "ok" }>): string {
  if (result.kind === "auth") return `authorization failed (${result.status})`;
  if (result.reason === "malformed") return "the orchestrator returned an invalid response";
  if (result.reason === "network") return "the orchestrator could not be reached";
  return `the orchestrator read failed${result.status === undefined ? "" : ` (${result.status})`}`;
}

function renderCostsShell(
  c: Context,
  ctx: ShellContext,
  props: Parameters<typeof CostsBody>[0],
): Response | Promise<Response> {
  return renderShell(c, ctx, { title: "tanren · costs" }, <CostsBody {...props} />);
}
