// rv-23 — the project-scoped runtime-verification PROOF DASHBOARD surfaces. Seven
// read-only views over the real org-scoped orchestrator endpoints (rv-23's proof
// dashboard reads + rv-22's run detail / behavior history). Each is directly
// callable at its project-scoped URL (like behavior-coverage); no nav-bar barrier
// edit is required. Every view fails closed: a scope that is not visible, or an
// orchestrator response that does not resolve, renders a BLOCKED state — never a
// fabricated green.
import type { Context, Hono } from "hono";
import { ProofDashboardClient } from "../../api/proofDashboardClient.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import { ProofMatrixBody } from "../../components/proofDashboard/ProofMatrixBody.js";
import {
  BehaviorDetailBody,
  BisectionBody,
  CausalityBody,
  DesignRenderBody,
  QuarantineBody,
  RunTimelineBody,
} from "../../components/proofDashboard/SurfaceBodies.js";

const NAV_ID = "behaviorProof";

function readClient(c: Context, deps: ShellDeps): ProofDashboardClient {
  return new ProofDashboardClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

function projectParam(c: Context): string {
  const projectId = c.req.param("projectId");
  if (projectId === undefined || projectId === "") throw new Error("projectId route parameter missing");
  return projectId;
}

/** The org id is only visible when the loaded shell project matches the path project. */
function visibleOrgId(ctx: ShellContext, projectId: string): string | undefined {
  if (ctx.org === undefined || ctx.project?.projectId !== projectId) return undefined;
  return ctx.org.id;
}

export function mountProofDashboardScreens(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/behavior-proof", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const matrix = orgId === undefined ? undefined : await readClient(c, deps).getMatrix(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · behavior proof matrix" },
      <ProofMatrixBody matrix={matrix} projectId={projectId} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/behaviors/:behaviorRevisionId", async (c: Context) => {
    const projectId = projectParam(c);
    const behaviorRevisionId = c.req.param("behaviorRevisionId") ?? "";
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const history =
      orgId === undefined
        ? undefined
        : await readClient(c, deps).getBehaviorHistory(orgId, projectId, behaviorRevisionId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · behavior detail" },
      <BehaviorDetailBody
        history={history}
        behaviorRevisionId={behaviorRevisionId}
        missingProject={orgId === undefined}
      />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/runs/:runId", async (c: Context) => {
    const projectId = projectParam(c);
    const runId = c.req.param("runId") ?? "";
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const detail = orgId === undefined ? undefined : await readClient(c, deps).getRunDetail(orgId, projectId, runId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · run assertion timeline" },
      <RunTimelineBody detail={detail} runId={runId} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/effects", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const causality = orgId === undefined ? undefined : await readClient(c, deps).getEffectCausality(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · external-effect causality" },
      <CausalityBody causality={causality} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/design-render", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const list = orgId === undefined ? undefined : await readClient(c, deps).getDesignRender(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · visual verification" },
      <DesignRenderBody list={list} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/bisections", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const list = orgId === undefined ? undefined : await readClient(c, deps).getBisections(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · merge-queue bisections" },
      <BisectionBody list={list} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });

  app.get("/projects/:projectId/behavior-proof/quarantines", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: NAV_ID, projectId });
    const orgId = visibleOrgId(ctx, projectId);
    const list = orgId === undefined ? undefined : await readClient(c, deps).getQuarantines(orgId, projectId);
    return renderShell(
      c,
      ctx,
      { title: "tanren · flake & quarantine" },
      <QuarantineBody list={list} missingProject={orgId === undefined} />,
    ) as Promise<Response>;
  });
}
