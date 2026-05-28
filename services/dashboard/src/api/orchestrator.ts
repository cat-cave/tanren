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
  OrgSummary,
  PaletteGroup,
  ProjectSummary,
  RunDetail,
  RunListItem,
  RunLocation
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

  // -------------------------------------------------------------------------
  // Run-detail read API (P2A-0014). The dashboard route is `/runs/:runId`
  // (the spec permits deriving org/project from the run); the orchestrator API
  // is org+project-scoped, so we resolve the run's location by scanning the
  // operator's orgs + projects for a matching run, then fetch the snapshot.
  // -------------------------------------------------------------------------

  /** List runs in a project. Empty array on failure. */
  async listRuns(orgId: string, projectId: string): Promise<RunListItem[]> {
    const response = await this.fetchImpl(
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs`,
      { headers: this.headers() }
    ).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { items?: RunListItem[] };
    return json.items ?? [];
  }

  /**
   * Resolve which org+project a run belongs to by scanning the operator's
   * orgs and their projects. `undefined` when the run is not visible. The
   * snapshot endpoint enforces the real authz boundary; this is just routing.
   */
  async findRunLocation(runId: string): Promise<RunLocation | undefined> {
    const orgs = await this.listOrgs();
    for (const org of orgs) {
      const projects = await this.listProjects(org.id);
      for (const project of projects) {
        const runs = await this.listRuns(org.id, project.projectId);
        if (runs.some((run) => run.runId === runId)) {
          return { orgId: org.id, projectId: project.projectId };
        }
      }
    }
    return undefined;
  }

  /**
   * Fetch the full run-detail snapshot. `rawView` opts into unredacted
   * payloads via `?raw=true` (the orchestrator emits the P2A-0009 audit
   * trail); the dashboard only sets it for admins. `undefined` when the run
   * is missing or access is denied.
   */
  async getRunDetail(
    loc: RunLocation,
    runId: string,
    opts: { rawView?: boolean } = {}
  ): Promise<RunDetail | undefined> {
    const query = opts.rawView === true ? "?raw=true" : "";
    const response = await this.fetchImpl(
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}${query}`,
      { headers: this.headers(opts.rawView === true ? { "x-view-raw": "true" } : undefined) }
    ).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json()) as RunDetail;
  }

  /** Build the SSE stream URL for the run's live feed (consumed by the client island). */
  streamUrl(loc: RunLocation, runId: string, opts: { rawView?: boolean } = {}): string {
    const query = opts.rawView === true ? "?raw=true" : "";
    return `${this.orchestratorUrl}/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}/stream${query}`;
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
