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
  BehaviorSummary,
  ForgeAnswer,
  InsightSummary,
  MilestoneSummary,
  OrgSummary,
  PaletteGroup,
  PersonaSummary,
  ProjectConfig,
  ProjectDetail,
  ProjectFeedItem,
  ProjectSummary,
  RunListItem,
  SpecSummary
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
  // P2B-0003 reads — project view, spec creation, routing settings. Each call
  // forwards the session cookie and degrades to an empty/undefined result on
  // failure so a page never 500s when one panel's data source is unavailable.
  // -------------------------------------------------------------------------

  private async getJson<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers()
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json().catch(() => undefined)) as T | undefined;
  }

  private async sendJson<T>(
    method: "POST" | "PATCH",
    path: string,
    body: unknown
  ): Promise<{ ok: boolean; status: number; body: T | undefined }> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      method,
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body)
    }).catch(() => undefined);
    if (response === undefined) {
      return { ok: false, status: 0, body: undefined };
    }
    const json = (await response.json().catch(() => undefined)) as T | undefined;
    return { ok: response.ok, status: response.status, body: json };
  }

  /** Runs for the project's attention queue + KPIs (P2A-0014). */
  async listRuns(
    orgId: string,
    projectId: string,
    query: { status?: string; specId?: string } = {}
  ): Promise<RunListItem[]> {
    const params = new URLSearchParams();
    if (query.status !== undefined && query.status !== "") params.set("status", query.status);
    if (query.specId !== undefined && query.specId !== "") params.set("specId", query.specId);
    const qs = params.toString();
    const json = await this.getJson<{ items?: RunListItem[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs${qs ? `?${qs}` : ""}`
    );
    return json?.items ?? [];
  }

  /** Project activity feed (P2A-0014). */
  async listFeed(orgId: string, projectId: string): Promise<ProjectFeedItem[]> {
    const json = await this.getJson<{ items?: ProjectFeedItem[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/feed`
    );
    return json?.items ?? [];
  }

  /** Workflow insights, filtered to the three v0-supported kinds (P2A-0020). */
  async listInsights(orgId: string, projectId: string): Promise<InsightSummary[]> {
    const json = await this.getJson<{ insights?: InsightSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/insights`
    );
    const all = json?.insights ?? [];
    const v0 = new Set(["retry_hotspot", "model_mismatch", "pace_anomaly"]);
    return all.filter((insight) => v0.has(insight.kind) && insight.acknowledgedAt === null);
  }

  /** Project milestones for the velocity card + spec form (P2A-0018). */
  async listMilestones(orgId: string, projectId: string): Promise<MilestoneSummary[]> {
    const json = await this.getJson<{ milestones?: MilestoneSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones`
    );
    return json?.milestones ?? [];
  }

  /** Project specs (spec list + dependency picker, P2A-0013). */
  async listSpecs(orgId: string, projectId: string): Promise<SpecSummary[]> {
    const json = await this.getJson<{ specs?: SpecSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`
    );
    return json?.specs ?? [];
  }

  /** Project personas — needed to enumerate behaviors (P2A-0018). */
  async listPersonas(orgId: string, projectId: string): Promise<PersonaSummary[]> {
    const json = await this.getJson<{ personas?: PersonaSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/personas`
    );
    return json?.personas ?? [];
  }

  /** Behaviors for a persona (the spec-form behavior picker, P2A-0018). */
  async listBehaviors(
    orgId: string,
    projectId: string,
    personaId: string
  ): Promise<BehaviorSummary[]> {
    const json = await this.getJson<{ behaviors?: BehaviorSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behaviors?personaId=${encodeURIComponent(personaId)}`
    );
    return json?.behaviors ?? [];
  }

  /** All project behaviors, gathered across personas (spec-form picker). */
  async listAllBehaviors(orgId: string, projectId: string): Promise<BehaviorSummary[]> {
    const personas = await this.listPersonas(orgId, projectId);
    const lists = await Promise.all(
      personas.map((persona) => this.listBehaviors(orgId, projectId, persona.id))
    );
    return lists.flat();
  }

  /** Full project incl. merged config (routing + escape hatches, P2A-0013). */
  async getProject(orgId: string, projectId: string): Promise<ProjectDetail | undefined> {
    return this.getJson<ProjectDetail>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`
    );
  }

  /** Persist project config (routing/escape-hatches save flow, P2A-0013). */
  async patchProjectConfig(
    orgId: string,
    projectId: string,
    config: ProjectConfig
  ): Promise<{ ok: boolean; status: number }> {
    const result = await this.sendJson<unknown>(
      "PATCH",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
      { config }
    );
    return { ok: result.ok, status: result.status };
  }

  /** Create a spec attached to the project (P2A-0013). */
  async createSpec(
    orgId: string,
    projectId: string,
    input: {
      title: string;
      description: string;
      acceptanceCriteria: string[];
      dependsOn?: string[];
    }
  ): Promise<{ ok: boolean; status: number; body: SpecSummary | undefined }> {
    return this.sendJson<SpecSummary>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`,
      input
    );
  }

  /**
   * Best-effort Forge project-view narration (P2A-0019): create a project
   * thread, generate the templated turn, and return its render payload. Any
   * failure yields `undefined` so the project view degrades to the
   * data-derived attention queue without the narration pulse line.
   */
  async generateProjectNarration(
    orgId: string,
    projectId: string,
    budgetUsdPerWeek?: number
  ): Promise<ForgeAnswer | undefined> {
    const thread = await this.sendJson<{ id?: string }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads`,
      { scope: "project", projectId }
    );
    const threadId = thread.body?.id;
    if (!thread.ok || threadId === undefined) {
      return undefined;
    }
    const turn = await this.sendJson<{ render?: ForgeAnswer }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads/${encodeURIComponent(threadId)}/turns/generate-project-view`,
      budgetUsdPerWeek === undefined ? { projectId } : { projectId, budgetUsdPerWeek }
    );
    return turn.body?.render;
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
