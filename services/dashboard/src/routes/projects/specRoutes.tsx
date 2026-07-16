/**
 * spec-detail routes — the spec drawer fragment (fetched by the
 * DAG-canvas island on node click) and the escalated full-page spec view.
 * Split out of `routes/projects/index.tsx` to keep both modules under the
 * 500-line cap. Reads compose the existing typed orchestrator reads (spec +
 * project spec list + run history); no new persisted data.
 *
 * Routes registered (after `/specs/new` so the static route is not shadowed):
 *   GET /projects/:projectId/specs/:specId/drawer   spec-drawer HTML fragment
 *   GET /projects/:projectId/specs/:specId          full-page spec view
 */

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { DagStatus } from "../../api/dagTypes.js";
import type { RunListItem, SpecSummary } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { DagStyles } from "../../components/project/dagStyles.js";
import { ScreenStyles } from "../../components/project/screenStyles.js";
import { buildSpecDetail, type SpecDetail } from "../../components/project/specDetail.js";
import { SpecDrawerBody, SpecPageBody } from "../../components/project/SpecDrawer.js";

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

export function notFoundBody(projectId: string) {
  return (
    <div class="p2b">
      <div class="page-head">
        <div>
          <div class="eyebrow">project · not found</div>
          <div class="page-title">project not found</div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>No project {projectId} is visible to you.</p>
        </section>
      </div>
    </div>
  );
}

export function mountSpecDetailRoutes(app: Hono, deps: ShellDeps): void {
  // Spec drawer fragment — bare markup (no shell chrome) injected by the island.
  app.get("/projects/:projectId/specs/:specId/drawer", async (c) => {
    const projectId = c.req.param("projectId");
    const specId = c.req.param("specId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return c.html("<div></div>", 404);
    }
    const detail = await loadSpecDetail(c, deps, ctx.org.id, projectId, specId);
    if (detail === undefined) {
      return c.html("<div></div>", 404);
    }
    return c.html(<SpecDrawerBody spec={detail} />);
  });

  // Full-page spec view — the "open full page ⤢" escalation from the drawer.
  app.get("/projects/:projectId/specs/:specId", async (c) => {
    const projectId = c.req.param("projectId");
    const specId = c.req.param("specId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
    if (ctx.org === undefined || ctx.project === undefined) {
      return renderShell(c, ctx, { title: "tanren · spec" }, notFoundBody(projectId));
    }
    const detail = await loadSpecDetail(c, deps, ctx.org.id, projectId, specId);
    if (detail === undefined) {
      return renderShell(c, ctx, { title: "tanren · spec" }, notFoundBody(projectId));
    }
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${detail.title}` },
      <>
        <ScreenStyles />
        <DagStyles />
        <SpecPageBody spec={detail} projectName={ctx.project.name} />
      </>,
    );
  });
}

/**
 * Resolve the project-view mode. An explicit `?mode=` query wins (the
 * toggle links carry it as the no-JS fallback); otherwise the persisted cookie
 * (`tanren_project_mode`, set by the dag-canvas island like the theme toggle)
 * decides; default is the chat-primary view.
 */
export function resolveProjectMode(c: Context): "chat" | "dag" {
  const q = c.req.query("mode");
  if (q === "dag" || q === "chat") return q;
  const cookie = c.req.header("cookie") ?? "";
  const match = /(?:^|;\s*)tanren_project_mode=(dag|chat)/u.exec(cookie);
  return match !== null && match[1] === "dag" ? "dag" : "chat";
}

/**
 * Load + shape a single spec's detail (drawer + full page). Composes the spec,
 * the project's spec list (for dep-chip titles + reverse "blocks" edges + dep
 * statuses), and the spec's run history. `undefined` when the spec is missing.
 * A failed run-list read is surfaced as `runsAvailable: false` so the full-page
 * run-history / economics panels show "unavailable" rather than fake zeros.
 */
async function loadSpecDetail(
  c: Context,
  deps: ShellDeps,
  orgId: string,
  projectId: string,
  specId: string,
): Promise<SpecDetail | undefined> {
  const client = clientFor(c, deps);
  const [allSpecs, specRunsMaybe, allRunsMaybe] = await Promise.all([
    client.listSpecs(orgId, projectId),
    client.listRunsMaybe(orgId, projectId, { specId }),
    client.listRunsMaybe(orgId, projectId),
  ]);
  const spec = allSpecs.find((s) => s.specId === specId);
  if (spec === undefined) return undefined;

  // Spec-scoped runs drive the history + economics panels; project-wide runs
  // colour dependency chips. Either failure is loud — never fake empty/status.
  const runsAvailable = specRunsMaybe !== undefined && allRunsMaybe !== undefined;
  const specRuns = runsAvailable ? (specRunsMaybe ?? []) : [];
  const allRuns = runsAvailable ? (allRunsMaybe ?? []) : [];

  const latestBySpec = new Map<string, RunListItem>();
  for (const run of allRuns) {
    if (!latestBySpec.has(run.specId)) latestBySpec.set(run.specId, run);
  }
  const statusBySpecId = new Map<string, DagStatus>();
  for (const other of allSpecs) {
    // When the project run-list is unavailable, do not invent dep status from
    // empty maps (which would look like every dep is merely "queued").
    statusBySpecId.set(other.specId, runsAvailable ? depStatus(other, latestBySpec.get(other.specId)) : "queued");
  }

  return buildSpecDetail({
    spec,
    allSpecs,
    runs: specRuns,
    statusBySpecId,
    runsAvailable,
    depsRunsAvailable: allRunsMaybe !== undefined,
  });
}

// HALTED-outcome policy set imported from @tanren/db — the prior private copy
// was missing `convergence_stalled` + `window_exhausted`, so a dep-chip whose
// latest run hit those outcomes did not colour blocked.

/** Latest-run → DagStatus for a dependency chip (mirrors the DAG model). */
function depStatus(
  spec: SpecSummary,
  run: { needsReview: boolean; status: string; outcome: string | null } | undefined,
): DagStatus {
  if (run !== undefined) {
    if (run.needsReview) return "review";
    if (run.status === "running") return "live";
    if (run.outcome !== null && RECOVERABLE_OUTCOMES.has(run.outcome)) return "blocked";
    if (run.status === "completed") return "done";
    if (run.status === "queued") return "queued";
  }
  const s = spec.status.toLowerCase();
  if (s === "merged") return "done";
  if (s === "in_flight" || s === "running") return "live";
  if (s === "review") return "review";
  if (s === "blocked" || s === "halted") return "blocked";
  return "queued";
}
