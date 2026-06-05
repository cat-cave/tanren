/**
 * DORA metrics route. Mounts ONE GET through the shell:
 *   GET /dora?windowDays=30 — org-level DORA-like delivery metrics panel.
 *
 * The four metrics (lead time, deploy frequency, change-failure rate, MTTR) are
 * computed orchestrator-side from existing run/event data (`GET .../dora`,
 *); this route just resolves the active project, fetches the payload,
 * and renders it through the shell. Reported, not targeted — no new collection.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts. Reuses
 * loadShellContext + renderShell; never touches the chrome. Overrides the
 * `/dora` placeholder for the `dora` sidenav row.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { DoraMetrics } from "../../api/dora.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { DoraBody } from "../../components/dora/DoraBody.js";

const VALID_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_WINDOW_DAYS = 30;

/** Parse the `windowDays` pill, falling back to 30d for anything unexpected. */
function parseWindowDays(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return VALID_WINDOWS.has(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

export function mountDoraScreen(app: Hono, deps: ShellDeps): void {
  app.get("/dora", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "dora" });
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    const project = ctx.projects[0];

    let metrics: DoraMetrics | undefined;
    if (ctx.org !== undefined && project !== undefined) {
      const client = new OrchestratorClient({
        orchestratorUrl: deps.orchestratorUrl,
        cookieHeader: c.req.header("cookie"),
      });
      metrics = await client.getDora(ctx.org.id, project.projectId, windowDays);
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · DORA metrics" },
      <DoraBody
        metrics={metrics}
        windowDays={windowDays}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
      />,
    );
  });
}
