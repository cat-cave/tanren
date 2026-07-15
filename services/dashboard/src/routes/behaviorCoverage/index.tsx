import type { Context, Hono } from "hono";
import type { AffectedSelection } from "../../api/behaviorCoverage.js";
import { AffectedTargetKindSchema } from "../../api/behaviorCoverage.js";
import { BehaviorCoverageClient } from "../../api/behaviorCoverageClient.js";
import { clientDepsFor } from "../../api/clientDeps.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import { BehaviorCoverageBody } from "../../components/behaviorCoverage/BehaviorCoverageBody.js";
import { formField } from "../formField.js";

interface ViewState {
  selection?: AffectedSelection;
  error?: string;
}

function readClient(c: Context, deps: ShellDeps): BehaviorCoverageClient {
  return new BehaviorCoverageClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<BehaviorCoverageClient> {
  return new BehaviorCoverageClient(await clientDepsFor(c, deps));
}

function projectParam(c: Context): string {
  const projectId = c.req.param("projectId");
  if (projectId === undefined || projectId === "") throw new Error("projectId route parameter missing");
  return projectId;
}

async function renderCoverage(
  c: Context,
  deps: ShellDeps,
  ctx: ShellContext,
  projectId: string,
  state: ViewState = {},
): Promise<Response> {
  const project = ctx.project;
  const snapshot =
    ctx.org === undefined || project === undefined
      ? undefined
      : await readClient(c, deps).getSnapshot(ctx.org.id, project.projectId);
  return renderShell(
    c,
    ctx,
    { title: "tanren · behavior coverage" },
    <BehaviorCoverageBody
      snapshot={snapshot}
      selection={state.selection}
      projectId={projectId}
      projectName={project?.name ?? ""}
      csrfToken={ctx.csrfToken}
      error={state.error}
      missingProject={project === undefined}
    />,
  ) as Promise<Response>;
}

/** Mount the visible rv-4 coverage matrix and its durable impact probe. */
export function mountBehaviorCoverageScreen(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/behavior-coverage", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "behaviorCoverage", projectId });
    return renderCoverage(c, deps, ctx, projectId);
  });

  app.post("/projects/:projectId/behavior-coverage/analyze", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "behaviorCoverage", projectId });
    if (ctx.org === undefined || ctx.project === undefined || ctx.project.projectId !== projectId) {
      return renderCoverage(c, deps, ctx, projectId, { error: "Project scope is not visible." });
    }

    const form = await c.req.parseBody();
    const kind = AffectedTargetKindSchema.safeParse(formField(form, "targetKind"));
    const targetRef = formField(form, "targetRef").trim();
    if (!kind.success || targetRef === "" || targetRef.length > 2_000) {
      return renderCoverage(c, deps, ctx, projectId, { error: "Enter a valid target kind and reference." });
    }

    const result = await (
      await writeClient(c, deps)
    ).analyze(ctx.org.id, projectId, {
      kind: kind.data,
      targetRef,
    });
    if (!result.ok || result.selection === undefined) {
      return renderCoverage(c, deps, ctx, projectId, {
        error: `The orchestrator did not persist an affected-selection fact (status ${result.status}).`,
      });
    }
    return renderCoverage(c, deps, ctx, projectId, { selection: result.selection });
  });
}
