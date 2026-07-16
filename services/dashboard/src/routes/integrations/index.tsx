/**
 * Org integrations two-plane route. Mounts through the shell:
 *   GET  /integrations                 — list grants + enable UI
 *   POST /integrations/link            — org-admin link proxy
 *   POST /integrations/enable          — project capability provision proxy
 *
 * Link is org-admin only on the orchestrator; enable branches on
 * `body.status === "not_linked"` (HTTP 200) rather than treating it as an
 * error. Mounted via ONE append to SCREEN_MOUNTS in app/screens.ts.
 */

import type { Context, Hono } from "hono";
import { clientDepsFor } from "../../api/clientDeps.js";
import { IntegrationsClient } from "../../api/integrationsClient.js";
import type { IntegrationLifecycleInventory, OrgIntegrationSummary } from "../../api/integrations.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { IntegrationsBody } from "../../components/integrations/IntegrationsBody.js";
import { formField } from "../formField.js";

function readClient(c: Context, deps: ShellDeps): IntegrationsClient {
  return new IntegrationsClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<IntegrationsClient> {
  return new IntegrationsClient(await clientDepsFor(c, deps));
}

function redirectTo(c: Context, path: string, notice?: string): Response {
  const url =
    notice === undefined ? path : `${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`;
  return c.redirect(url, 303);
}

function isOrgAdminRole(role: string | undefined): boolean {
  return role === "org:admin" || role === "platform:admin";
}

export function mountIntegrationsScreen(app: Hono, deps: ShellDeps): void {
  app.get("/integrations", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations" });
    const project = ctx.projects[0];
    const noticeRaw = c.req.query("notice");
    const notice = noticeRaw === undefined || noticeRaw === "" ? undefined : noticeRaw;
    const notLinkedProvider = c.req.query("notLinked");
    const notLinkedMessage = c.req.query("notLinkedMsg");
    const selectionProvider = c.req.query("selectionRequired");
    const selectionMessage = c.req.query("selectionMsg");

    let integrations: OrgIntegrationSummary[] | undefined;
    let lifecycle: IntegrationLifecycleInventory | undefined;
    if (ctx.org !== undefined) {
      const client = readClient(c, deps);
      const list = await client.list(ctx.org.id, project?.projectId);
      // undefined list → read failure (unavailable). Present empty array only
      // when the orchestrator explicitly returned { integrations: [] }.
      integrations = list?.integrations;
      lifecycle = list?.lifecycle;
    }

    return renderShell(
      c,
      ctx,
      { title: "tanren · integrations" },
      <IntegrationsBody
        integrations={integrations}
        projectId={project?.projectId ?? ""}
        lifecycle={lifecycle}
        projectName={project?.name ?? ""}
        noProject={project === undefined}
        isOrgAdmin={isOrgAdminRole(ctx.org?.role)}
        notice={notice}
        notLinked={
          notLinkedProvider === undefined || notLinkedProvider === ""
            ? undefined
            : {
                providerKind: notLinkedProvider,
                ...(notLinkedMessage === undefined || notLinkedMessage === "" ? {} : { message: notLinkedMessage }),
              }
        }
        selectionRequired={
          selectionProvider === undefined || selectionProvider === ""
            ? undefined
            : {
                providerKind: selectionProvider,
                ...(selectionMessage === undefined || selectionMessage === "" ? {} : { message: selectionMessage }),
              }
        }
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // Persist the account choice before any provider discovery/provision call.
  app.post("/integrations/select", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations" });
    const orgId = ctx.org?.id;
    if (orgId === undefined) return redirectTo(c, "/integrations", "no org in session");
    const form = await c.req.parseBody();
    const projectId = formField(form, "projectId").trim();
    const providerKind = formField(form, "providerKind").trim();
    const connectionId = formField(form, "connectionId").trim();
    const grantId = formField(form, "grantId").trim();
    const authGeneration = Number(formField(form, "authGeneration").trim());
    const grantGeneration = Number(formField(form, "grantGeneration").trim());
    if (
      projectId === "" ||
      providerKind === "" ||
      connectionId === "" ||
      grantId === "" ||
      !Number.isInteger(authGeneration) ||
      authGeneration < 1 ||
      !Number.isInteger(grantGeneration) ||
      grantGeneration < 1
    ) {
      return redirectTo(c, "/integrations", "missing account selection fields");
    }
    const client = await writeClient(c, deps);
    const result = await client.selectGrant(orgId, projectId, providerKind, {
      connectionId,
      grantId,
      authGeneration,
      grantGeneration,
    });
    return result.ok
      ? redirectTo(c, "/integrations", `selected ${providerKind} principal`)
      : redirectTo(c, "/integrations", `account selection failed (${result.status})`);
  });

  // ── link (Plane A write) ────────────────────────────────────────────────
  app.post("/integrations/link", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations" });
    const orgId = ctx.org?.id;
    if (orgId === undefined) {
      return redirectTo(c, "/integrations", "no org in session");
    }
    const form = await c.req.parseBody();
    const providerKind = formField(form, "providerKind").trim();
    const token = formField(form, "token");
    const idempotencyKey = formField(form, "idempotencyKey").trim() || `link-${providerKind}-${Date.now()}`;
    if (providerKind === "" || token === "") {
      return redirectTo(c, "/integrations", "missing provider or token");
    }
    const client = await writeClient(c, deps);
    const result = await client.link(orgId, providerKind, { token, idempotencyKey });
    if (result.status === 403) {
      return redirectTo(c, "/integrations", "org admin required to link");
    }
    if (!result.ok) {
      return redirectTo(c, "/integrations", `link failed (${result.status})`);
    }
    const bodyStatus =
      result.body !== undefined && typeof result.body === "object" && "status" in result.body
        ? String((result.body as { status?: unknown }).status)
        : "completed";
    if (bodyStatus === "awaiting_principal_selection") {
      return redirectTo(c, "/integrations", `${providerKind} requires principal selection`);
    }
    if (bodyStatus === "failed") {
      return redirectTo(c, "/integrations", `${providerKind} verification failed`);
    }
    return redirectTo(c, "/integrations", `linked ${providerKind}`);
  });

  // ── enable capability (Plane B write) ───────────────────────────────────
  app.post("/integrations/enable", async (c: Context) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "integrations" });
    const orgId = ctx.org?.id;
    if (orgId === undefined) {
      return redirectTo(c, "/integrations", "no org in session");
    }
    const form = await c.req.parseBody();
    const projectId = formField(form, "projectId").trim();
    const capability = formField(form, "capability").trim();
    const providerKind = formField(form, "providerKind").trim();
    if (projectId === "" || capability === "") {
      return redirectTo(c, "/integrations", "missing project or capability");
    }
    const client = await writeClient(c, deps);
    const result = await client.provision(orgId, projectId, {
      capability,
      ...(providerKind === "" ? {} : { providerKind }),
      mode: "brownfield",
      name: ctx.projects.find((p) => p.projectId === projectId)?.name,
    });
    // not_linked is a structured 200 — surface the affordance, not an error.
    if (result.body?.status === "not_linked") {
      const pk =
        "providerKind" in result.body && typeof result.body.providerKind === "string"
          ? result.body.providerKind
          : providerKind;
      const msg = "message" in result.body && typeof result.body.message === "string" ? result.body.message : undefined;
      const qs = new URLSearchParams({ notLinked: pk });
      if (msg !== undefined) qs.set("notLinkedMsg", msg);
      return c.redirect(`/integrations?${qs.toString()}`, 303);
    }
    if (result.body?.status === "selection_required") {
      const qs = new URLSearchParams({ selectionRequired: result.body.providerKind });
      if (result.body.message !== undefined) qs.set("selectionMsg", result.body.message);
      return c.redirect(`/integrations?${qs.toString()}`, 303);
    }
    if (!result.ok) {
      return redirectTo(c, "/integrations", `enable failed (${result.status})`);
    }
    return redirectTo(c, "/integrations", `enabled ${capability}${providerKind === "" ? "" : ` via ${providerKind}`}`);
  });
}
