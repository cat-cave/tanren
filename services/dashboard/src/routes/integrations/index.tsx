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
        csrfToken={ctx.csrfToken}
      />,
    );
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
    const upstreamAccountId = formField(form, "upstreamAccountId").trim();
    const authKind = parseAuthKind(formField(form, "authKind").trim());
    const token = formField(form, "token");
    if (providerKind === "" || upstreamAccountId === "" || authKind === undefined || token === "") {
      return redirectTo(c, "/integrations", "missing provider, account, auth kind, or token");
    }
    const client = await writeClient(c, deps);
    const result = await client.link(orgId, providerKind, { token, upstreamAccountId, authKind });
    if (result.status === 403) {
      return redirectTo(c, "/integrations", "org admin required to link");
    }
    if (!result.ok) {
      return redirectTo(c, "/integrations", `link failed (${result.status})`);
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
    if (!result.ok) {
      return redirectTo(c, "/integrations", `enable failed (${result.status})`);
    }
    return redirectTo(c, "/integrations", `enabled ${capability}${providerKind === "" ? "" : ` via ${providerKind}`}`);
  });
}

function parseAuthKind(
  value: string,
): "api_key" | "oauth2" | "bot_token" | "webhook" | "workload_identity" | undefined {
  switch (value) {
    case "api_key":
    case "oauth2":
    case "bot_token":
    case "webhook":
    case "workload_identity":
      return value;
    default:
      return undefined;
  }
}
