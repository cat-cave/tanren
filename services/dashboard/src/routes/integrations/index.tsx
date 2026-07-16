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
import type {
  IntegrationLifecycleInventory,
  OrgIntegrationSummary,
  PrincipalSelectionCandidate,
  PublicLinkOpStatus,
} from "../../api/integrations.js";
import { PUBLIC_LINK_OP_STATUSES } from "../../api/integrations.js";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { ProjectDetail, ProjectSummary } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { IntegrationsBody } from "../../components/integrations/IntegrationsBody.js";
import { formField } from "../formField.js";

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["projectId"] === "string" &&
    typeof row["name"] === "string" &&
    typeof row["repoUrl"] === "string" &&
    isStringOrNull(row["defaultBranch"]) &&
    isStringOrNull(row["runnerImage"]) &&
    isStringOrNull(row["allocator"])
  );
}

function isExactProject(value: unknown, projectId: string): value is ProjectDetail {
  if (!isProjectSummary(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    row["projectId"] === projectId &&
    row["config"] !== null &&
    typeof row["config"] === "object" &&
    !Array.isArray(row["config"])
  );
}

class IntegrationProjectClient extends OrchestratorClient {
  private async exactJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response?.status !== 200) return undefined;
    return response.json().catch(() => {});
  }

  async listProjectsMaybe(orgId: string): Promise<ProjectSummary[] | undefined> {
    const body = await this.exactJson(`/orgs/${encodeURIComponent(orgId)}/projects`);
    if (body === null || typeof body !== "object") return undefined;
    const projects = (body as Record<string, unknown>)["projects"];
    return Array.isArray(projects) && projects.every((project) => isProjectSummary(project)) ? projects : undefined;
  }

  async readExactProject(orgId: string, projectId: string): Promise<unknown> {
    return this.exactJson(`/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`);
  }
}

function projectClient(c: Context, deps: ShellDeps): IntegrationProjectClient {
  return new IntegrationProjectClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function loadIntegrationsContext(c: Context, deps: ShellDeps) {
  const shell = await loadShellContext(c, deps, { activeNavId: "integrations" });
  const available = shell.org === undefined ? [] : await projectClient(c, deps).listProjectsMaybe(shell.org.id);
  const projectsUnavailable = available === undefined;
  const projects = available ?? [];
  return {
    ...shell,
    projects,
    project: projects[0],
    projectsUnavailable,
  };
}

async function projectForWrite(
  c: Context,
  deps: ShellDeps,
  ctx: Awaited<ReturnType<typeof loadIntegrationsContext>>,
  projectId: string,
): Promise<ProjectDetail | undefined> {
  if (
    ctx.org === undefined ||
    ctx.projectsUnavailable ||
    !ctx.projects.some((project) => project.projectId === projectId)
  ) {
    return undefined;
  }
  const exact = await projectClient(c, deps).readExactProject(ctx.org.id, projectId);
  return isExactProject(exact, projectId) ? exact : undefined;
}

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

function linkPostOutcome(body: unknown): { status: PublicLinkOpStatus; operationId?: string } {
  if (body === null || typeof body !== "object") return { status: "malformed" };
  const record = body as Record<string, unknown>;
  const operationId =
    typeof record["operationId"] === "string" && record["operationId"] !== "" ? record["operationId"] : undefined;
  const rawStatus = record["status"];
  if (typeof rawStatus !== "string")
    return { status: "malformed", ...(operationId === undefined ? {} : { operationId }) };
  const status = (PUBLIC_LINK_OP_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as PublicLinkOpStatus)
    : "unknown";
  return { status, ...(operationId === undefined ? {} : { operationId }) };
}

function publicFailureClassification(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : undefined;
}

function publicRetryAfter(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return undefined;
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

// eslint-disable-next-line max-lines-per-function -- convergent multi-phase saga must stay ordered
export function mountIntegrationsScreen(app: Hono, deps: ShellDeps): void {
  app.get("/integrations", async (c: Context) => {
    const ctx = await loadIntegrationsContext(c, deps);
    const project = ctx.projects[0];
    const noticeRaw = c.req.query("notice");
    const notice = noticeRaw === undefined || noticeRaw === "" ? undefined : noticeRaw;
    const notLinkedProvider = c.req.query("notLinked");
    const notLinkedMessage = c.req.query("notLinkedMsg");
    const selectionProvider = c.req.query("selectionRequired");
    const selectionMessage = c.req.query("selectionMsg");
    const principalOp = c.req.query("principalOp");
    const principalProvider = c.req.query("principalProvider");
    const principalStatus = c.req.query("principalStatus");

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

    let principalSelection:
      | {
          providerKind: string;
          operationId: string;
          candidates: PrincipalSelectionCandidate[];
          status?: PublicLinkOpStatus | "invalidated" | "unavailable";
          failureClassification?: string;
          retryAfter?: string;
        }
      | undefined;
    // Query carries operation id only — durable candidates reloaded from the
    // operation endpoint so refresh/truncated/forged URL cannot authorize outside the op.
    if (principalOp !== undefined && principalOp !== "" && ctx.org !== undefined) {
      const client = readClient(c, deps);
      const op = await client.getOperation(ctx.org.id, principalOp);
      if (op === undefined) {
        principalSelection = {
          providerKind: principalProvider ?? "unknown",
          operationId: principalOp,
          candidates: [],
          status: "unavailable",
        };
      } else {
        const negativeOverride = ["invalidated", "malformed", "unknown", "failed"].includes(principalStatus ?? "")
          ? (principalStatus as "invalidated" | "malformed" | "unknown" | "failed")
          : undefined;
        const mapped = (PUBLIC_LINK_OP_STATUSES as readonly string[]).includes(op.publicStatus)
          ? op.publicStatus
          : "unknown";
        const failureClassification = publicFailureClassification(op.failureClassification);
        const retryAfter = publicRetryAfter(op.retryAfter);
        principalSelection = {
          providerKind: op.providerKind,
          operationId: op.operationId,
          candidates: op.candidates,
          status: negativeOverride ?? mapped,
          ...(failureClassification === undefined ? {} : { failureClassification }),
          ...(retryAfter === undefined ? {} : { retryAfter }),
        };
      }
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
        noProject={!ctx.projectsUnavailable && project === undefined}
        projectsUnavailable={ctx.projectsUnavailable}
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
        principalSelection={principalSelection}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  // Persist the account choice before any provider discovery/provision call.
  app.post("/integrations/select", async (c: Context) => {
    const ctx = await loadIntegrationsContext(c, deps);
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
    const project = await projectForWrite(c, deps, ctx, projectId);
    if (project === undefined) {
      return redirectTo(c, "/integrations", "project unavailable or not visible");
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
    const ctx = await loadIntegrationsContext(c, deps);
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
    const outcome = linkPostOutcome(result.body);
    if (outcome.status === "completed") return redirectTo(c, "/integrations", `linked ${providerKind}`);
    if (outcome.operationId === undefined) {
      return redirectTo(c, "/integrations", `${providerKind} link outcome ${outcome.status}`);
    }
    const qs = new URLSearchParams({ principalOp: outcome.operationId, principalProvider: providerKind });
    if (["malformed", "unknown", "failed"].includes(outcome.status)) qs.set("principalStatus", outcome.status);
    return c.redirect(`/integrations?${qs.toString()}`, 303);
  });

  // ── multi-principal selection (Plane A resume) ──────────────────────────
  app.post("/integrations/select-principal", async (c: Context) => {
    const ctx = await loadIntegrationsContext(c, deps);
    const orgId = ctx.org?.id;
    if (orgId === undefined) return redirectTo(c, "/integrations", "no org in session");
    const form = await c.req.parseBody();
    const operationId = formField(form, "operationId").trim();
    const providerPrincipalId = formField(form, "providerPrincipalId").trim();
    if (operationId === "" || providerPrincipalId === "") {
      return redirectTo(c, "/integrations", "missing principal selection fields");
    }
    const client = await writeClient(c, deps);
    const result = await client.selectPrincipal(orgId, operationId, { providerPrincipalId });
    if (result.status === 409) {
      const qs = new URLSearchParams({
        principalOp: operationId,
        principalProvider: "unknown",
        principalStatus: "invalidated",
      });
      return c.redirect(`/integrations?${qs.toString()}`, 303);
    }
    if (!result.ok) {
      const qs = new URLSearchParams({
        principalOp: operationId,
        principalProvider: "unknown",
        principalStatus: "failed",
      });
      return c.redirect(`/integrations?${qs.toString()}`, 303);
    }
    return redirectTo(c, "/integrations", "principal selected");
  });

  // ── enable capability (Plane B write) ───────────────────────────────────
  app.post("/integrations/enable", async (c: Context) => {
    const ctx = await loadIntegrationsContext(c, deps);
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
    const project = await projectForWrite(c, deps, ctx, projectId);
    if (project === undefined) {
      return redirectTo(c, "/integrations", "project unavailable or not visible");
    }
    const client = await writeClient(c, deps);
    const result = await client.provision(orgId, projectId, {
      capability,
      ...(providerKind === "" ? {} : { providerKind }),
      mode: "brownfield",
      name: project.name,
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
