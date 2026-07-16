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
  readonly selection?: AffectedSelection;
  readonly error?: string;
  readonly replayNotice?: string;
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

function visibleOrgId(ctx: ShellContext, projectId: string): string | undefined {
  if (ctx.org === undefined || ctx.project?.projectId !== projectId) return undefined;
  return ctx.org.id;
}

async function renderCoverage(
  c: Context,
  deps: ShellDeps,
  ctx: ShellContext,
  projectId: string,
  state: ViewState = {},
): Promise<Response> {
  const orgId = visibleOrgId(ctx, projectId);
  const overview = orgId === undefined ? undefined : await readClient(c, deps).getOverview(orgId, projectId);
  return renderShell(
    c,
    ctx,
    { title: "tanren · behavior coverage" },
    <BehaviorCoverageBody
      overview={overview}
      selection={state.selection}
      projectId={projectId}
      projectName={orgId === undefined ? "" : (ctx.project?.name ?? "")}
      csrfToken={ctx.csrfToken}
      error={state.error}
      replayNotice={state.replayNotice}
      missingProject={orgId === undefined}
    />,
  ) as Promise<Response>;
}

/** Mount the visible rv-4 coverage matrix, immutable analysis, and replay proof. */
export function mountBehaviorCoverageScreen(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/behavior-coverage", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "behaviorCoverage", projectId });
    return renderCoverage(c, deps, ctx, projectId);
  });

  app.post("/projects/:projectId/behavior-coverage/analyze", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "behaviorCoverage", projectId });
    const orgId = visibleOrgId(ctx, projectId);
    if (orgId === undefined) {
      return renderCoverage(c, deps, ctx, projectId, { error: "Project scope is not visible." });
    }
    const form = await c.req.parseBody();
    const kind = AffectedTargetKindSchema.safeParse(formField(form, "targetKind"));
    const targetRef = formField(form, "targetRef").trim();
    const integrationNodeId = formField(form, "integrationNodeId").trim();
    if (
      !kind.success ||
      targetRef === "" ||
      targetRef.length > 2_000 ||
      integrationNodeId === "" ||
      integrationNodeId.length > 200
    ) {
      return renderCoverage(c, deps, ctx, projectId, {
        error: "Enter a valid integration node, target kind, and target reference.",
      });
    }
    const result = await (
      await writeClient(c, deps)
    ).analyze(orgId, projectId, {
      integrationNodeId,
      target: { kind: kind.data, targetRef },
    });
    if (!result.ok || result.selection === undefined) {
      return renderCoverage(c, deps, ctx, projectId, {
        error: `The orchestrator did not persist an affected-selection fact (status ${result.status}).`,
      });
    }
    return renderCoverage(c, deps, ctx, projectId, { selection: result.selection });
  });

  app.post("/projects/:projectId/behavior-coverage/verify", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "behaviorCoverage", projectId });
    const orgId = visibleOrgId(ctx, projectId);
    if (orgId === undefined) {
      return renderCoverage(c, deps, ctx, projectId, { error: "Project scope is not visible." });
    }
    const form = await c.req.parseBody();
    const analysisId = formField(form, "analysisId").trim();
    if (!/^sha256:[0-9a-f]{64}$/u.test(analysisId)) {
      return renderCoverage(c, deps, ctx, projectId, { error: "Affected-selection identity is malformed." });
    }
    const result = await (await writeClient(c, deps)).verify(orgId, projectId, analysisId);
    if (result.verification?.status === "stale") {
      return renderCoverage(c, deps, ctx, projectId, {
        replayNotice: "Selection is stale: the graph or integration-node identity changed. It cannot be reused.",
      });
    }
    if (!result.ok) {
      return renderCoverage(c, deps, ctx, projectId, {
        error: `The selection could not be verified (status ${result.status}).`,
      });
    }
    return renderCoverage(c, deps, ctx, projectId, {
      replayNotice: "Selection is current for its exact graph, integration node, head, tree, and member set.",
    });
  });
}
