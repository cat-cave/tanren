/**
 * Project audit-posture settings BFF.
 *
 * GET  /settings/governance?projectId=... reads the canonical governance view.
 * POST /settings/governance proxies only auditPosture to the canonical org-admin
 * PUT, then redirects so success and authorization/server failures stay visible.
 */

import type { Context, Hono } from "hono";
import { AuditPostureSchema } from "../../api/governance.js";
import { GovernanceClient } from "../../api/governanceClient.js";
import { clientDepsFor } from "../../api/clientDeps.js";
import type { ProjectSummary } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { GovernanceBody, type GovernanceFlash } from "../../components/governance/GovernanceBody.js";
import { formField } from "../formField.js";

function readClient(c: Context, deps: ShellDeps): GovernanceClient {
  return new GovernanceClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<GovernanceClient> {
  return new GovernanceClient(await clientDepsFor(c, deps));
}

function resolveProject(projects: ProjectSummary[], requestedId: string | undefined): ProjectSummary | undefined {
  if (requestedId === undefined || requestedId === "") return projects[0];
  return projects.find((project) => project.projectId === requestedId);
}

function flashFromQuery(c: Context): GovernanceFlash {
  if (c.req.query("ok") === "saved") {
    return { kind: "ok", message: "Audit posture saved through the canonical governance authority." };
  }
  switch (c.req.query("err")) {
    case "invalid":
      return { kind: "err", message: "Invalid audit posture. Choose a supported severity and residual policy." };
    case "forbidden":
      return { kind: "err", message: "Save denied — org-admin authority is required. The posture was not changed." };
    case "rejected":
      return { kind: "err", message: "Save rejected by governance validation. The posture was not changed." };
    case "save_failed":
      return { kind: "err", message: "Governance save failed at the orchestrator. The posture was not changed." };
    case "malformed_save":
      return {
        kind: "err",
        message:
          "The orchestrator acknowledged the save but returned malformed confirmation. Treat the outcome as unknown and verify before retrying.",
      };
    case "conflict":
      return {
        kind: "err",
        message: "Governance changed concurrently. Current values were reloaded; review them before retrying.",
      };
    case "no_project":
      return { kind: "err", message: "The requested project is not visible; no governance write was attempted." };
    default:
      return undefined;
  }
}

function redirect(projectId: string, outcome: string): string {
  return `/settings/governance?projectId=${encodeURIComponent(projectId)}&${outcome}`;
}

export function mountGovernanceScreen(app: Hono, deps: ShellDeps): void {
  app.get("/settings/governance", async (c) => {
    const requestedId = c.req.query("projectId");
    const ctx = await loadShellContext(c, deps, { activeNavId: "governance", projectId: requestedId });
    const project = resolveProject(ctx.projects, requestedId);
    const scopedCtx = project === undefined ? ctx : { ...ctx, project };
    const readResult =
      ctx.org === undefined || project === undefined
        ? undefined
        : await readClient(c, deps).getProjectGovernance(ctx.org.id, project.projectId);

    return renderShell(
      c,
      scopedCtx,
      { title: "tanren · governance" },
      <GovernanceBody
        projects={ctx.projects}
        project={project}
        governance={readResult?.ok === true ? readResult.body : undefined}
        readFailure={readResult?.ok === false ? readResult.failure : undefined}
        flash={flashFromQuery(c)}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  app.post("/settings/governance", async (c) => {
    const form = await c.req.parseBody();
    const projectId = formField(form, "projectId").trim();
    if (projectId === "") return c.redirect("/settings/governance?err=no_project");

    const ctx = await loadShellContext(c, deps, { activeNavId: "governance", projectId });
    const project = resolveProject(ctx.projects, projectId);
    if (ctx.org === undefined || project === undefined || project.projectId !== projectId) {
      return c.redirect(redirect(projectId, "err=no_project"));
    }

    const posture = AuditPostureSchema.safeParse({
      blockReviewAt: formField(form, "blockReviewAt"),
      p2p3Handling: formField(form, "p2p3Handling"),
      autonomousRemediation: formField(form, "autonomousRemediation") === "true",
    });
    if (!posture.success) return c.redirect(redirect(projectId, "err=invalid"));

    const result = await (await writeClient(c, deps)).putAuditPosture(ctx.org.id, projectId, posture.data);
    if (result.ok) return c.redirect(redirect(projectId, "ok=saved"));
    if (result.failure === "malformed") return c.redirect(redirect(projectId, "err=malformed_save"));
    if (result.status === 403) return c.redirect(redirect(projectId, "err=forbidden"));
    if (result.status === 400) return c.redirect(redirect(projectId, "err=rejected"));
    if (result.status === 409) return c.redirect(redirect(projectId, "err=conflict"));
    return c.redirect(redirect(projectId, "err=save_failed"));
  });
}
