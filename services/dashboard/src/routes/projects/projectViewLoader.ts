/**
 * Request, client, and model assembly for the project-view route.
 *
 * The route renderer consumes this typed result and does not own orchestrator
 * reads. Keeping the read sequence here preserves the project view's existing
 * availability and DAG-fallback behavior while leaving JSX concerns in the
 * renderer module.
 */

import type { Context } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import { getProjectDag, ProjectDagUnavailableError, type ProjectDag } from "../../api/projectDag.js";
import type { InsightSummary } from "../../api/types.js";
import { loadShellContext, type ShellDeps } from "../../app/mountShell.js";
import {
  buildProjectViewModel,
  summarizeRunCosts,
  type ProjectViewModel,
} from "../../components/project/projectViewData.js";
import { resolveProjectMode } from "./specRoutes.js";

type ProjectViewShellContext = Awaited<ReturnType<typeof loadShellContext>>;

export type ProjectViewDagState =
  | { kind: "not-requested" }
  | { kind: "available"; dag: ProjectDag }
  | { kind: "unavailable" };

export type ProjectViewLoadResult =
  | {
      kind: "not-found";
      projectId: string;
      ctx: ProjectViewShellContext;
    }
  | {
      kind: "ready";
      projectId: string;
      orgId: string;
      projectName: string;
      ctx: ProjectViewShellContext;
      mode: "chat" | "dag";
      model: ProjectViewModel;
      insights: InsightSummary[];
      dag: ProjectViewDagState;
    };

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

/** Load all request-scoped data needed to render GET /projects/:projectId. */
export async function loadProjectView(c: Context, deps: ShellDeps): Promise<ProjectViewLoadResult> {
  const projectId = c.req.param("projectId");
  if (projectId === undefined) {
    throw new Error("Project view route requires a projectId parameter.");
  }
  const ctx = await loadShellContext(c, deps, { activeNavId: "projects", projectId });
  if (ctx.org === undefined || ctx.project === undefined) {
    return { kind: "not-found", projectId, ctx };
  }

  const orgId = ctx.org.id;
  // GET is read-only: never mint forge threads/turns from a safe method.
  // Live narration is POST /forge/project-narration (inbound CSRF + outbound
  // clientDepsFor). Pulse falls back to data-derived copy when undefined.
  const client = clientFor(c, deps);
  const mode = resolveProjectMode(c);
  const [runsMaybe, insights, milestones, feed] = await Promise.all([
    client.listRunsMaybe(orgId, projectId),
    client.listInsights(orgId, projectId),
    client.listMilestones(orgId, projectId),
    client.listFeed(orgId, projectId),
  ]);
  const runs = runsMaybe ?? [];
  const model = buildProjectViewModel({
    projectId,
    projectName: ctx.project.name,
    runs,
    runsAvailable: runsMaybe !== undefined,
    insights,
    milestones,
    feed,
    narration: undefined,
    weekSpend: summarizeRunCosts(runs),
  });

  if (mode !== "dag") {
    return {
      kind: "ready",
      projectId,
      orgId,
      projectName: ctx.project.name,
      ctx,
      mode,
      model,
      insights,
      dag: { kind: "not-requested" },
    };
  }

  try {
    const dag = await getProjectDag(client, orgId, projectId);
    return {
      kind: "ready",
      projectId,
      orgId,
      projectName: ctx.project.name,
      ctx,
      mode,
      model,
      insights,
      dag: { kind: "available", dag },
    };
  } catch (error) {
    if (!(error instanceof ProjectDagUnavailableError)) throw error;
    return {
      kind: "ready",
      projectId,
      orgId,
      projectName: ctx.project.name,
      ctx,
      mode,
      model,
      insights,
      dag: { kind: "unavailable" },
    };
  }
}
