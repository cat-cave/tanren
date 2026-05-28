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
  CostRecord,
  CursorPage,
  OrgSummary,
  PaletteGroup,
  ProjectSummary,
  RunListItem
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
   * Filtered run list for a project (`GET .../runs`, P2A-0014). Backs the
   * history list. Empty array on failure / unauthenticated. `status` and
   * `specId` are optional server-side filters.
   */
  async listRuns(
    orgId: string,
    projectId: string,
    filters: { status?: string; specId?: string } = {}
  ): Promise<RunListItem[]> {
    const params = new URLSearchParams();
    if (filters.status !== undefined && filters.status !== "") params.set("status", filters.status);
    if (filters.specId !== undefined && filters.specId !== "") params.set("specId", filters.specId);
    const query = params.toString();
    const url =
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs` +
      (query === "" ? "" : `?${query}`);
    const response = await this.fetchImpl(url, { headers: this.headers() }).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { items?: RunListItem[] };
    return json.items ?? [];
  }

  /**
   * All cost records for a run (`GET .../runs/:runId/costs`, P2A-0011), walking
   * the cursor pages so the costs dashboard sees the full set. Capped at
   * `maxPages` so a runaway cursor can never spin forever. Empty on failure.
   */
  async listRunCosts(
    orgId: string,
    projectId: string,
    runId: string,
    opts: { maxPages?: number } = {}
  ): Promise<CostRecord[]> {
    const maxPages = opts.maxPages ?? 20;
    const base = `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(
      projectId
    )}/runs/${encodeURIComponent(runId)}/costs`;
    const all: CostRecord[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const url = cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
      const response = await this.fetchImpl(url, { headers: this.headers() }).catch(() => undefined);
      if (response === undefined || !response.ok) {
        break;
      }
      const json = (await response.json()) as Partial<CursorPage<CostRecord>>;
      for (const item of json.items ?? []) {
        all.push(item);
      }
      cursor = json.nextCursor ?? null;
      if (cursor === null) {
        break;
      }
    }
    return all;
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
