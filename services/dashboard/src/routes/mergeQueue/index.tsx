/**
 * Merge-queue route. Mounts ONE GET through the shell:
 *   GET /merge-queue?windowDays=30 — org-level native-delivery metrics panel.
 *
 * Two aggregate views (rebase-vs-rebuild + native queue stats) are computed
 * orchestrator-side from the engine's own events (`GET .../integration-metrics`,
 * `GET .../queue-stats`); this route resolves the active project, fetches both
 * payloads, and renders them through the shell. Reported, not targeted — no new
 * collection, no engine change.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts. Reuses
 * loadShellContext + renderShell; never touches the chrome.
 */

import type { Context, Hono } from "hono";
import {
  MergeQueueAuthoritySignalsClient,
  type MergeQueueAuthoritySignalsResponse,
} from "../../api/mergeQueueAuthoritySignals.js";
import { MergeQueueClient } from "../../api/mergeQueueClient.js";
import type { IntegrationMetrics, QueueStats } from "../../api/mergeQueue.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { MergeQueueBody } from "../../components/mergeQueue/MergeQueueBody.js";

const VALID_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_WINDOW_DAYS = 30;

/** Parse the `windowDays` pill, falling back to 30d for anything unexpected. */
function parseWindowDays(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return VALID_WINDOWS.has(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

export function mountMergeQueueScreen(app: Hono, deps: ShellDeps): void {
  app.get("/merge-queue", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "mergeQueue" });
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    const evaluationId = c.req.query("evaluationId")?.trim() || undefined;
    const project = ctx.projects[0];

    let metrics: IntegrationMetrics | undefined;
    let stats: QueueStats | undefined;
    let authoritySignals: MergeQueueAuthoritySignalsResponse | undefined;
    if (ctx.org !== undefined && project !== undefined) {
      const client = new MergeQueueClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const authorityClient = new MergeQueueAuthoritySignalsClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      const authorityRead =
        evaluationId === undefined
          ? null
          : authorityClient.getAuthoritySignals(ctx.org.id, project.projectId, evaluationId);
      const [nextMetrics, nextStats, nextAuthoritySignals] = await Promise.all([
        client.getIntegrationMetrics(ctx.org.id, project.projectId, windowDays),
        client.getQueueStats(ctx.org.id, project.projectId, windowDays),
        authorityRead,
      ]);
      metrics = nextMetrics;
      stats = nextStats;
      if (nextAuthoritySignals !== null) authoritySignals = nextAuthoritySignals;
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · merge queue" },
      <MergeQueueBody
        metrics={metrics}
        stats={stats}
        authoritySignals={authoritySignals}
        authorityEvaluationId={evaluationId}
        windowDays={windowDays}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
      />,
    );
  });
}
