// ds-5 — the design Studio screen router: within-org reuse catalog + binding +
// evidence lab + exports, plus the reuse-binding form POST. Mounted at
// `/projects/:projectId/design-studio`. Fail-closed: the org id resolves only
// when the loaded project matches the path (else every section is BLOCKED and no
// fetch runs); each read is independently verified 200-or-BLOCKED by the client.

import type { Context, Hono } from "hono";
import type { DesignStudioView } from "../../api/designStudio.js";
import { DesignStudioClient } from "../../api/designStudioClient.js";
import { clientDepsFor } from "../../api/clientDeps.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import type { ShellContext } from "../../app/shell.js";
import { DesignStudioBody } from "../../components/designStudio/DesignStudioBody.js";
import { formField } from "../formField.js";

interface ViewState {
  readonly notice?: string;
  readonly error?: string;
}

function readClient(c: Context, deps: ShellDeps): DesignStudioClient {
  return new DesignStudioClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<DesignStudioClient> {
  return new DesignStudioClient(await clientDepsFor(c, deps));
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

async function loadView(c: Context, deps: ShellDeps, orgId: string, projectId: string): Promise<DesignStudioView> {
  const client = readClient(c, deps);
  const [systems, binding, evidence] = await Promise.all([
    client.getCatalog(orgId),
    client.getBinding(orgId, projectId),
    client.getEvidence(orgId, projectId),
  ]);
  // The exports shown are the bound system's latest published release's artifact.
  // No binding / no published release → an empty (not BLOCKED) exports section.
  const boundSystem =
    binding === null || binding === undefined
      ? undefined
      : (systems ?? []).find((s) => s.designSystemId === binding.designSystemId);
  const artifactId = boundSystem?.latestPublishedRelease?.canonicalArtifactId;
  const exports = artifactId === undefined ? [] : await client.getExports(orgId, artifactId);
  return { systems, binding, evidence, exports };
}

async function render(
  c: Context,
  deps: ShellDeps,
  ctx: ShellContext,
  projectId: string,
  state: ViewState = {},
): Promise<Response> {
  const orgId = visibleOrgId(ctx, projectId);
  const view: DesignStudioView =
    orgId === undefined
      ? { systems: undefined, binding: undefined, evidence: undefined, exports: undefined }
      : await loadView(c, deps, orgId, projectId);
  return renderShell(
    c,
    ctx,
    { title: "tanren · design studio" },
    <DesignStudioBody
      view={view}
      projectId={projectId}
      projectName={orgId === undefined ? "" : (ctx.project?.name ?? "")}
      csrfToken={ctx.csrfToken}
      missingProject={orgId === undefined}
      notice={state.notice}
      error={state.error}
    />,
  ) as Promise<Response>;
}

/** Mount the visible ds-5 design Studio (reuse / evidence / exports) + bind form. */
export function mountDesignStudioScreens(app: Hono, deps: ShellDeps): void {
  app.get("/projects/:projectId/design-studio", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "designStudio", projectId });
    return render(c, deps, ctx, projectId);
  });

  app.post("/projects/:projectId/design-studio/bind", async (c: Context) => {
    const projectId = projectParam(c);
    const ctx = await loadShellContext(c, deps, { activeNavId: "designStudio", projectId });
    const orgId = visibleOrgId(ctx, projectId);
    if (orgId === undefined) return render(c, deps, ctx, projectId, { error: "Project scope is not visible." });
    const form = await c.req.parseBody();
    const designSystemId = formField(form, "designSystemId").trim();
    const pinMode = formField(form, "pinMode").trim();
    const pinnedReleaseId = formField(form, "pinnedReleaseId").trim();
    const channel = formField(form, "channel").trim();
    if (designSystemId === "" || (pinMode !== "release" && pinMode !== "channel")) {
      return render(c, deps, ctx, projectId, { error: "Choose a design system and a valid pin mode." });
    }
    if (pinMode === "release" && pinnedReleaseId === "") {
      return render(c, deps, ctx, projectId, { error: "A release pin needs a release id." });
    }
    if (pinMode === "channel" && channel === "") {
      return render(c, deps, ctx, projectId, { error: "A channel pin needs a channel name." });
    }
    const result = await (
      await writeClient(c, deps)
    ).putBinding(orgId, projectId, {
      designSystemId,
      pinMode,
      ...(pinMode === "release" ? { pinnedReleaseId } : { channel }),
    });
    if (!result.ok || result.binding === undefined) {
      return render(c, deps, ctx, projectId, {
        error: result.message ?? `The orchestrator rejected the binding (status ${result.status}).`,
      });
    }
    return render(c, deps, ctx, projectId, {
      notice: `Project now reuses ${result.binding.designSystemId} (${result.binding.pinMode} pin).`,
    });
  });
}
