import type { Hono } from "hono";
import { IntegrationEventsClient } from "../../api/integrationEvents.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { IntegrationEventsViewer } from "../../components/integrations/IntegrationEventsViewer.js";

// Project-scoped integration lifecycle event viewer. The WAVE-2 barrier
// pre-claimed the screen mount in `app/screens.ts`; this route owns only its
// read client + visible body.
export function mountIntegrationEventsScreen(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/integration-events", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations", projectId });
    const orgId = ctx.org?.id !== undefined && ctx.project?.projectId === projectId ? ctx.org.id : undefined;
    const read =
      orgId === undefined
        ? undefined
        : await new IntegrationEventsClient({
            orchestratorUrl: deps.orchestratorUrl,
            cookieHeader: c.req.header("cookie"),
          }).list(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · integration events" },
      <IntegrationEventsViewer events={read?.events} projectId={projectId} projectName={ctx.project?.name ?? ""} />,
    );
  });
}
