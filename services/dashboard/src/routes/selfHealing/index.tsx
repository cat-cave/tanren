/**
 * bh-14b — the Self-Healing screen. Mounts TWO GETs through the shell:
 *   GET /self-healing                                   — org-wide funnel + loops
 *   GET /self-healing/projects/:projectId/loops/:loopId — loop-detail causal graph
 *                                                          + the six truth badges
 *
 * Both read real org-scoped orchestrator surfaces: the bh-14b funnel aggregate and
 * the bh-14a sealed resolution-proof chain. No write/seal surface is exposed.
 *
 * Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts; reuses
 * loadShellContext + renderShell and never touches the chrome. Overrides the
 * `/self-healing` placeholder for the `selfHealing` sidenav row.
 */

import type { Context, Hono } from "hono";
import { SelfHealingClient } from "../../api/selfHealingClient.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { LoopDetailBody } from "../../components/selfHealing/LoopDetailBody.js";
import { SelfHealingBody } from "../../components/selfHealing/SelfHealingBody.js";

function readClient(c: Context, deps: ShellDeps): SelfHealingClient {
  return new SelfHealingClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`${name} route parameter missing`);
  return value;
}

export function mountSelfHealingScreen(app: Hono, deps: ShellDeps): void {
  app.get("/self-healing", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "selfHealing" });
    const funnel = ctx.org === undefined ? undefined : await readClient(c, deps).getFunnel(ctx.org.id);
    return renderShell(
      c,
      ctx,
      { title: "tanren · self-healing" },
      <SelfHealingBody funnel={funnel} orgLogin={ctx.org?.login ?? ""} noOrg={ctx.org === undefined} />,
    );
  });

  app.get("/self-healing/projects/:projectId/loops/:loopId", async (c: Context) => {
    const projectId = requireParam(c, "projectId");
    const loopId = requireParam(c, "loopId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "selfHealing", projectId });
    const proofResponse =
      ctx.org === undefined ? undefined : await readClient(c, deps).getLoopProof(ctx.org.id, projectId, loopId);
    return renderShell(
      c,
      ctx,
      { title: `tanren · self-healing · ${loopId}` },
      <LoopDetailBody
        proofResponse={proofResponse}
        loopId={loopId}
        projectId={projectId}
        missingScope={ctx.org === undefined}
      />,
    );
  });
}
