import type { Hono } from "hono";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";

// in-3 barrier stub — the integration-events viewer surface.
//
// The WAVE-2 barrier pre-flight registers this mount so the in-3 consumer node
// never has to edit the shared `screens.ts`; in-3 fills in the real read model +
// body under this `routes/integrationEvents/**` subtree (its own, non-shared
// path). The route is project-scoped and directly callable at its URL; no nav row
// is required (mirrors the rv-4 behavior-coverage screen convention).
export function mountIntegrationEventsScreen(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/integration-events", async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations", projectId });
    return renderShell(
      c,
      ctx,
      { title: "tanren · integration events" },
      <section>
        <h1>Integration events</h1>
        <p>The integration lifecycle event viewer lands with in-3.</p>
      </section>,
    );
  });
}
