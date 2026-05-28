/**
 * Typed fetch client for the orchestrator product APIs the dashboard shell
 * needs: session (`/auth/me`), orgs, projects, and the Forge tool surface
 * (palette items + write-action invocation).
 *
 * Every request forwards the inbound dashboard request's `cookie` header so the
 * orchestrator can validate the `tanren_session` cookie. The client degrades
 * gracefully: a missing/invalid session yields `undefined`/empty collections
 * rather than throwing, which keeps the dev ergonomics working under
 * `TANREN_REQUIRE_AUTH=0` (orchestrator returns a local-dev actor).
 */

import type { DashboardSession } from "../auth/session.js";
import type {
  BrownfieldLinkResult,
  CreatedProject,
  CredentialRecord,
  DoctorReport,
  NotificationMatrix,
  NotificationRoute,
  NotificationTarget,
  OrgSummary,
  PaletteGroup,
  ProjectSummary
} from "./types.js";

export interface OrchestratorClientDeps {
  orchestratorUrl: string;
  /** Inbound dashboard request cookie header, forwarded for session auth. */
  cookieHeader?: string;
  fetchImpl?: typeof fetch;
}

export class OrchestratorClient {
  private readonly orchestratorUrl: string;
  private readonly cookieHeader: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: OrchestratorClientDeps) {
    this.orchestratorUrl = deps.orchestratorUrl;
    this.cookieHeader = deps.cookieHeader;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") {
      base.cookie = this.cookieHeader;
    }
    return base;
  }

  /** Resolve the current session via `/auth/me`. `undefined` when unauthenticated. */
  async session(): Promise<DashboardSession | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/auth/me`, {
      headers: this.headers()
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json()) as DashboardSession;
  }

  /** Orgs the operator is a member of. Empty array when unauthenticated. */
  async listOrgs(): Promise<OrgSummary[]> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/orgs`, {
      headers: this.headers()
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { orgs?: OrgSummary[] };
    return json.orgs ?? [];
  }

  /** Projects in an org the operator can access. Empty array on failure. */
  async listProjects(orgId: string): Promise<ProjectSummary[]> {
    const response = await this.fetchImpl(
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects`,
      { headers: this.headers() }
    ).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { projects?: ProjectSummary[] };
    return json.projects ?? [];
  }

  /**
   * Invoke a Forge write tool (operator-button action) via
   * `POST /orgs/:orgId/forge/tools`. Returns the raw `{ tool, result }` body or
   * `undefined` on failure (the caller decides how to surface it).
   */
  async invokeForgeTool(
    orgId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/forge/tools`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ tool, args })
      }
    ).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return response.json();
  }

  // ── P2B-0002 onboarding / credentials / notifications ──────────────────

  private async getJson<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers()
    }).catch(() => undefined);
    if (response === undefined || !response.ok) return undefined;
    return (await response.json()) as T;
  }

  private async sendJson(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch(() => undefined);
    if (response === undefined) return { ok: false, status: 0, body: undefined };
    const parsed = await response.json().catch(() => undefined);
    return { ok: response.ok, status: response.status, body: parsed };
  }

  /** Stack-health report (P2A-0013 `/doctor`). `undefined` when unreachable. */
  async doctor(): Promise<DoctorReport | undefined> {
    return this.getJson<DoctorReport>("/doctor");
  }

  /** Org-scoped credential references (P2A-0013). Never returns values. */
  async listOrgCredentials(orgId: string): Promise<CredentialRecord[]> {
    const json = await this.getJson<{ credentials?: CredentialRecord[] }>(
      `/orgs/${encodeURIComponent(orgId)}/credentials`
    );
    return json?.credentials ?? [];
  }

  /** Personal credential references (P2A-0013). Never returns values. */
  async listMyCredentials(): Promise<CredentialRecord[]> {
    const json = await this.getJson<{ credentials?: CredentialRecord[] }>("/credentials/me");
    return json?.credentials ?? [];
  }

  /** Import a credential (write-only). `kind` selects the typed import path. */
  async importCredential(input: {
    scope: "org" | "me";
    orgId?: string;
    kind: string;
    body: Record<string, unknown>;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const base =
      input.scope === "org"
        ? `/orgs/${encodeURIComponent(input.orgId ?? "")}/credentials`
        : "/credentials/me";
    return this.sendJson("POST", `${base}?kind=${encodeURIComponent(input.kind)}`, input.body);
  }

  /** Delete an org-scoped credential reference (P2A-0013). */
  async deleteOrgCredential(orgId: string, ref: string): Promise<boolean> {
    const result = await this.sendJson(
      "DELETE",
      `/orgs/${encodeURIComponent(orgId)}/credentials/${encodeURIComponent(ref)}`
    );
    return result.ok;
  }

  /** Create a project row (P2A-0013, non-brownfield create path). */
  async createProject(
    orgId: string,
    body: Record<string, unknown>
  ): Promise<CreatedProject | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/projects`, body);
    if (!result.ok) return undefined;
    return result.body as CreatedProject;
  }

  /**
   * Link a target repo (P2A-0013 brownfield). Reads `.github/workflows/`,
   * `.mergify.yml`, `CODEOWNERS` for display; WRITES NOTHING to the target.
   */
  async brownfieldLink(
    orgId: string,
    projectId: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; result?: BrownfieldLinkResult; error?: string }> {
    const result = await this.sendJson(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/link`,
      body
    );
    if (!result.ok) {
      const errBody = result.body as { error?: string; message?: string } | undefined;
      return { ok: false, status: result.status, error: errBody?.message ?? errBody?.error };
    }
    return { ok: true, status: result.status, result: result.body as BrownfieldLinkResult };
  }

  /** The full notifications matrix for an org (P2A-0017). Empty on failure. */
  async notificationMatrix(orgId: string): Promise<NotificationMatrix> {
    const json = await this.getJson<NotificationMatrix>(
      `/orgs/${encodeURIComponent(orgId)}/notifications/matrix`
    );
    return json ?? { targets: [], routes: [], events: [] };
  }

  /** Create a notification target (P2A-0017). */
  async createNotificationTarget(
    orgId: string,
    body: Record<string, unknown>
  ): Promise<NotificationTarget | undefined> {
    const result = await this.sendJson(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/notifications/targets`,
      body
    );
    if (!result.ok) return undefined;
    return result.body as NotificationTarget;
  }

  /** Create/replace a notification route opt-in (P2A-0017). */
  async createNotificationRoute(
    orgId: string,
    body: Record<string, unknown>
  ): Promise<NotificationRoute | undefined> {
    const result = await this.sendJson(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/notifications/routes`,
      body
    );
    if (!result.ok) return undefined;
    return result.body as NotificationRoute;
  }
}

/**
 * Build the v0 palette groups for an org's project context. These are the
 * templated suggestions described in the spec — quick actions (read routes),
 * forge-this write suggestions (operator-button tools), and ask-forge prompts.
 * Thick-LLM palette responses are Phase 3; this surface is deliberately static.
 *
 * Read actions carry `route`; write actions carry a `tool` id declared in the
 * P2A-0019 Forge tool surface so the palette can never invoke an undeclared
 * tool. Projects are passed in so quick actions can deep-link the live project.
 */
export function buildPaletteGroups(input: {
  orgLogin: string;
  projects: ProjectSummary[];
}): PaletteGroup[] {
  const firstProject = input.projects[0];
  const quickActions: PaletteGroup = {
    group: "quick actions",
    items: [
      {
        glyph: "+",
        title: "new spec",
        desc: "describe work · tanren plans & forges",
        route: firstProject ? `/projects/${firstProject.projectId}/specs/new` : "/onboarding/new"
      },
      {
        glyph: "→",
        title: firstProject ? `go to ${firstProject.name}` : "go to a project",
        desc: firstProject ? firstProject.repoUrl : "no projects yet · onboard one",
        route: firstProject ? `/projects/${firstProject.projectId}` : "/onboarding/existing"
      },
      {
        glyph: "↻",
        title: "review halted runs",
        desc: "runs that hit an escape hatch",
        route: firstProject ? `/projects/${firstProject.projectId}/runs/halted` : "/projects"
      }
    ]
  };
  const forgeThis: PaletteGroup = {
    group: "forge this",
    items: [
      {
        glyph: "鍛",
        kanji: true,
        title: "draft a spec from rough notes",
        desc: "i'll plan & dependency-rank it",
        tool: "tanren.create_spec",
        args: firstProject ? { projectId: firstProject.projectId } : {}
      },
      {
        glyph: "鍛",
        kanji: true,
        title: "acknowledge a suboptimal callout",
        desc: "clear an open insight",
        tool: "tanren.acknowledge_insight",
        args: {}
      }
    ]
  };
  const askForge: PaletteGroup = {
    group: "ask forge",
    items: [
      { glyph: "?", title: "what's blocking my milestones?", desc: "natural-language query", route: "/overview" },
      { glyph: "?", title: "how are my costs trending?", desc: "this week vs last", route: "/costs" }
    ]
  };
  return [quickActions, forgeThis, askForge];
}
