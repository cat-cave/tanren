/**
 * P2B-0006 operator-triggered live workflow — the run-trigger mount.
 *
 * The "▶ start a run" affordance in the spec UI (SpecListBody) is a server-
 * rendered `<form method="post">` that POSTs here. This route resolves the
 * active org from the shell context, forwards the operator's optional branch,
 * and calls the typed orchestrator client's `triggerRun` with
 * `trigger: "dashboard"` so the run's origin is recorded as the dashboard flow.
 *
 * On a 201 it redirects (303 POST-redirect-GET, so a browser refresh never
 * re-submits) to `/runs/:runId` — the P2B-0004 live run-detail view with its
 * SSE feed. On a 4xx it re-renders the spec list with a typed, operator-facing
 * error banner: 409 spec_dependencies_blocked / spec_not_runnable are
 * meaningful feedback, NOT swallowed. A forced halt later surfaces on the
 * run-detail view and routes to the P2B-0008 recovery surface; see
 * docs/operator-guide/operator-driven-run.md.
 *
 * Mounted via the append-only screen registry (`app/screens.ts`) so its POST
 * route claims its path before the shell fills gaps. Owns ONLY the run-trigger
 * sub-surface under `routes/runs/trigger/**`.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../../api/orchestrator.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../../app/mountShell.js";
import { SpecListBody } from "../../../components/project/SpecCreateBody.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
}

/** Map a failed trigger response to an operator-facing message. */
function triggerErrorMessage(status: number, body: unknown): string {
  const error = (body as { error?: string } | undefined)?.error;
  if (status === 0) return "could not reach the orchestrator. try again.";
  if (status === 403) return "you do not have access to start a run for this spec.";
  if (status === 404) return "that spec no longer exists.";
  if (error === "spec_dependencies_blocked" || status === 409) {
    if (error === "spec_not_runnable") {
      return "this spec is not runnable — it has already started a run or is not in a runnable state.";
    }
    return "this spec is blocked: a spec it depends on has not finished yet. complete the dependency, then try again.";
  }
  if (error === "invalid_run") return "the run request was rejected as invalid.";
  return `could not start the run (status ${status}).`;
}

export function mountTriggerScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // POST /projects/:projectId/specs/:specId/run — trigger a live run.
  // -------------------------------------------------------------------------
  app.post("/projects/:projectId/specs/:specId/run", async (c) => {
    const projectId = c.req.param("projectId");
    const specId = c.req.param("specId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });

    const reRender = (error: string) => renderSpecListWithError(c, deps, ctx, projectId, specId, error);

    if (ctx.org === undefined || ctx.project === undefined) {
      return reRender("no org/project context — sign in and pick a project, then try again.");
    }

    const form = await c.req.parseBody();
    const branchRaw = String(form.branch ?? "").trim();
    const client = clientFor(c, deps);
    const result = await client.triggerRun(ctx.org.id, projectId, specId, {
      trigger: "dashboard",
      ...(branchRaw !== "" ? { branch: branchRaw } : {})
    });

    if (result.ok && result.body !== undefined) {
      // POST-redirect-GET to the live run-detail view (P2B-0004).
      return c.redirect(`/runs/${encodeURIComponent(result.body.runId)}`, 303);
    }
    return reRender(triggerErrorMessage(result.status, result.body));
  });
}

/**
 * Re-render the project spec list with the trigger error surfaced inline on the
 * offending spec row. Reloads the specs + recent-runs the list needs (the same
 * reads the GET spec-list route performs).
 */
async function renderSpecListWithError(
  c: Context,
  deps: ShellDeps,
  ctx: Awaited<ReturnType<typeof loadShellContext>>,
  projectId: string,
  specId: string,
  error: string
) {
  if (ctx.org === undefined || ctx.project === undefined) {
    return renderShell(
      c,
      ctx,
      { title: "tanren · run" },
      <div class="p2b">
        <div class="page-body">
          <section class="placeholder-card">
            <p>{error}</p>
            <p class="placeholder-note">
              <a href="/projects">← back to projects</a>
            </p>
          </section>
        </div>
      </div>
    );
  }
  const client = clientFor(c, deps);
  const [specs, runs] = await Promise.all([
    client.listSpecs(ctx.org.id, projectId),
    client.listRuns(ctx.org.id, projectId)
  ]);
  const runBySpec: Record<string, string | undefined> = {};
  for (const run of runs) {
    if (runBySpec[run.specId] === undefined) runBySpec[run.specId] = run.runId;
  }
  return renderShell(
    c,
    ctx,
    { title: `tanren · ${ctx.project.name} specs` },
    <SpecListBody
      project={ctx.project}
      specs={specs}
      runBySpec={runBySpec}
      error={error}
      errorSpecId={specId}
    />
  );
}
