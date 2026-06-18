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
import type { DoraMetrics } from "./dora.js";
import { OrchestratorOrgConfigClient } from "./orgConfigClient.js";
import type {
  BehaviorSummary,
  BrownfieldLinkResult,
  CostRecord,
  CreatedProject,
  CredentialRecord,
  CursorPage,
  DoctorReport,
  ForgeAnswer,
  InsightSummary,
  MilestoneSummary,
  NotificationMatrix,
  NotificationRoute,
  NotificationTarget,
  OrgSummary,
  PersonaSummary,
  ProjectConfig,
  ProjectDetail,
  ProjectFeedItem,
  ProjectSummary,
  RunDetail,
  RunListItem,
  RunLocation,
  RunSummary,
  SpecSummary,
} from "./types.js";

export type { OrchestratorClientDeps } from "./httpClient.js";

export class OrchestratorClient extends OrchestratorOrgConfigClient {
  /** Resolve the current session via `/auth/me`. `undefined` when unauthenticated. */
  async session(): Promise<DashboardSession | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/auth/me`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json()) as DashboardSession;
  }

  /**
   * The orchestrator's configured identity providers + the canonical GitHub App
   * install URL (`/auth/providers`). The dashboard reads the install URL FROM the
   * orchestrator (one source of truth) rather than its own env. `undefined` when
   * the orchestrator is unreachable or has not configured the App.
   */
  async authGithubAppInstallUrl(): Promise<string | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/auth/providers`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return undefined;
    }
    const json = (await response.json()) as { githubAppInstallUrl?: string };
    return json.githubAppInstallUrl;
  }

  /** Orgs the operator is a member of. Empty array when unauthenticated. */
  async listOrgs(): Promise<OrgSummary[]> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/orgs`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { orgs?: OrgSummary[] };
    return json.orgs ?? [];
  }

  /** Projects in an org the operator can access. Empty array on failure. */
  async listProjects(orgId: string): Promise<ProjectSummary[]> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return [];
    }
    const json = (await response.json()) as { projects?: ProjectSummary[] };
    return json.projects ?? [];
  }

  /**
   * All cost records for a run (`GET .../runs/:runId/costs`), walking the cursor pages
   * until the cursor is exhausted so the costs dashboard sees the FULL set. Progress-
   * based: each page MUST yield a NEW cursor — a repeated cursor means the API stopped
   * advancing, so the walk STOPS on that (returning what it has) rather than looping
   * forever. Empty on failure.
   */
  async listRunCosts(orgId: string, projectId: string, runId: string): Promise<CostRecord[]> {
    const base = `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(
      projectId,
    )}/runs/${encodeURIComponent(runId)}/costs`;
    const all: CostRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const url = cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
      const response = await this.fetchImpl(url, { headers: this.headers() }).catch(() => {});
      if (response === undefined || !response.ok) {
        break;
      }
      const json = (await response.json()) as Partial<CursorPage<CostRecord>>;
      for (const item of json.items ?? []) {
        all.push(item);
      }
      const nextCursor = json.nextCursor ?? null;
      // Stop on an exhausted OR non-advancing cursor (a repeated cursor would loop
      // forever). The dashboard read is best-effort, so a non-advancing API stops the
      // walk with what it has rather than throwing.
      if (nextCursor === null || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return all;
  }

  /**
   * Invoke a Forge write tool (operator-button action) via
   * `POST /orgs/:orgId/forge/tools`. Returns the raw `{ tool, result }` body or
   * `undefined` on failure (the caller decides how to surface it).
   */
  async invokeForgeTool(orgId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/forge/tools`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ tool, args }),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return response.json();
  }

  // Product reads/writes below use the shared `getJson`/`sendJson` helpers from
  // `OrchestratorHttpClient`; each forwards the session cookie and degrades to
  // an empty/undefined result so a page never 500s when a data source is down.

  /** Runs for the project's attention queue + KPIs. */
  async listRuns(
    orgId: string,
    projectId: string,
    query: { status?: string; specId?: string } = {},
  ): Promise<RunListItem[]> {
    const params = new URLSearchParams();
    if (query.status !== undefined && query.status !== "") params.set("status", query.status);
    if (query.specId !== undefined && query.specId !== "") params.set("specId", query.specId);
    const qs = params.toString();
    const json = await this.getJson<{ items?: RunListItem[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs${qs ? `?${qs}` : ""}`,
    );
    return json?.items ?? [];
  }

  /** Project activity feed. */
  async listFeed(orgId: string, projectId: string): Promise<ProjectFeedItem[]> {
    const json = await this.getJson<{ items?: ProjectFeedItem[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/feed`,
    );
    return json?.items ?? [];
  }

  /**
   * Workflow insights, filtered to the supported kinds (trio plus the
   * `stuck` + `review_stall` and the `ci_flaky` additions).
   * Acknowledged rows drop out.
   */
  async listInsights(orgId: string, projectId: string): Promise<InsightSummary[]> {
    const json = await this.getJson<{ insights?: InsightSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/insights`,
    );
    const all = json?.insights ?? [];
    const supported = new Set(["retry_hotspot", "model_mismatch", "pace_anomaly", "stuck", "review_stall", "ci_flaky"]);
    return all.filter((insight) => supported.has(insight.kind) && insight.acknowledgedAt === null);
  }

  /**
   * DORA-like delivery metrics for a project over a window. Reported,
   * not targeted; derived from existing run/event data. `undefined` on failure
   * so the panel degrades to an empty state instead of 500-ing.
   */
  async getDora(orgId: string, projectId: string, windowDays?: number): Promise<DoraMetrics | undefined> {
    const qs = windowDays === undefined ? "" : `?windowDays=${windowDays}`;
    const json = await this.getJson<{ metrics?: DoraMetrics }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/dora${qs}`,
    );
    return json?.metrics;
  }

  /** Project milestones for the velocity card + spec form. */
  async listMilestones(orgId: string, projectId: string): Promise<MilestoneSummary[]> {
    const json = await this.getJson<{ milestones?: MilestoneSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones`,
    );
    return json?.milestones ?? [];
  }

  /** Project specs (spec list + dependency picker). */
  async listSpecs(orgId: string, projectId: string): Promise<SpecSummary[]> {
    const json = await this.getJson<{ specs?: SpecSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`,
    );
    return json?.specs ?? [];
  }

  /** Project personas — needed to enumerate behaviors. */
  async listPersonas(orgId: string, projectId: string): Promise<PersonaSummary[]> {
    const json = await this.getJson<{ personas?: PersonaSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/personas`,
    );
    return json?.personas ?? [];
  }

  /** Behaviors for a persona (the spec-form behavior picker). */
  async listBehaviors(orgId: string, projectId: string, personaId: string): Promise<BehaviorSummary[]> {
    const json = await this.getJson<{ behaviors?: BehaviorSummary[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behaviors?personaId=${encodeURIComponent(personaId)}`,
    );
    return json?.behaviors ?? [];
  }

  /** All project behaviors, gathered across personas (spec-form picker). */
  async listAllBehaviors(orgId: string, projectId: string): Promise<BehaviorSummary[]> {
    const personas = await this.listPersonas(orgId, projectId);
    const lists = await Promise.all(personas.map((persona) => this.listBehaviors(orgId, projectId, persona.id)));
    return lists.flat();
  }

  /** Full project incl. merged config (routing + escape hatches). */
  async getProject(orgId: string, projectId: string): Promise<ProjectDetail | undefined> {
    return this.getJson<ProjectDetail>(`/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`);
  }

  /** Persist project config (routing/escape-hatches save flow). */
  async patchProjectConfig(
    orgId: string,
    projectId: string,
    config: ProjectConfig,
  ): Promise<{ ok: boolean; status: number }> {
    const result = await this.sendJson(
      "PATCH",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
      { config },
    );
    return { ok: result.ok, status: result.status };
  }

  /** Create a spec attached to the project. */
  async createSpec(
    orgId: string,
    projectId: string,
    input: {
      title: string;
      description: string;
      acceptanceCriteria: string[];
      dependsOn?: string[];
    },
  ): Promise<{ ok: boolean; status: number; body: SpecSummary | undefined }> {
    return this.sendJson<SpecSummary>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`,
      input,
    );
  }

  /**
   * Trigger a live run from a spec. POSTs to the orchestrator's
   * run-from-spec endpoint with `trigger: "dashboard"` so the run's origin is
   * recorded as the operator-driven dashboard flow. The body is forwarded as-is
   * by `sendJson`, so a 4xx (403 org/project access, 409 deps-blocked /
   * not-runnable) surfaces with its status for the route handler to render.
   */
  async triggerRun(
    orgId: string,
    projectId: string,
    specId: string,
    input: { trigger?: string; branch?: string } = {},
  ): Promise<{ ok: boolean; status: number; body: RunSummary | undefined }> {
    return this.sendJson<RunSummary>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`,
      {
        trigger: input.trigger ?? "dashboard",
        ...(input.branch === undefined ? {} : { branch: input.branch }),
      },
    );
  }

  /**
   * Best-effort Forge project-view narration: create a project
   * thread, generate the templated turn, and return its render payload. Any
   * failure yields `undefined` so the project view degrades to the
   * data-derived attention queue without the narration pulse line.
   */
  async generateProjectNarration(
    orgId: string,
    projectId: string,
    budgetUsdPerWeek?: number,
  ): Promise<ForgeAnswer | undefined> {
    const thread = await this.sendJson<{ id?: string }>("POST", `/orgs/${encodeURIComponent(orgId)}/forge/threads`, {
      scope: "project",
      projectId,
    });
    const threadId = thread.body?.id;
    if (!thread.ok || threadId === undefined) {
      return undefined;
    }
    const turn = await this.sendJson<{ render?: ForgeAnswer }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads/${encodeURIComponent(threadId)}/turns/generate-project-view`,
      budgetUsdPerWeek === undefined ? { projectId } : { projectId, budgetUsdPerWeek },
    );
    return turn.body?.render;
  }

  // ── onboarding / credentials / notifications ──────────────────

  /** Stack-health report (`/doctor`). `undefined` when unreachable. */
  async doctor(): Promise<DoctorReport | undefined> {
    return this.getJson<DoctorReport>("/doctor");
  }

  /** Org-scoped credential references. Never returns values. */
  async listOrgCredentials(orgId: string): Promise<CredentialRecord[]> {
    const json = await this.getJson<{ credentials?: CredentialRecord[] }>(
      `/orgs/${encodeURIComponent(orgId)}/credentials`,
    );
    return json?.credentials ?? [];
  }

  /** Personal credential references. Never returns values. */
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
      input.scope === "org" ? `/orgs/${encodeURIComponent(input.orgId ?? "")}/credentials` : "/credentials/me";
    return this.sendJson("POST", `${base}?kind=${encodeURIComponent(input.kind)}`, input.body);
  }

  /** Delete an org-scoped credential reference. */
  async deleteOrgCredential(orgId: string, ref: string): Promise<boolean> {
    const result = await this.sendJson(
      "DELETE",
      `/orgs/${encodeURIComponent(orgId)}/credentials/${encodeURIComponent(ref)}`,
    );
    return result.ok;
  }

  /** Create a project row (non-brownfield create path). */
  async createProject(orgId: string, body: Record<string, unknown>): Promise<CreatedProject | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/projects`, body);
    if (!result.ok) return undefined;
    return result.body as CreatedProject;
  }

  /**
   * Link a target repo (brownfield). Reads `.github/workflows/` and
   * `CODEOWNERS` for display; WRITES NOTHING to the target.
   */
  async brownfieldLink(
    orgId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; result?: BrownfieldLinkResult; error?: string }> {
    const result = await this.sendJson(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/link`,
      body,
    );
    if (!result.ok) {
      const errBody = result.body as { error?: string; message?: string } | undefined;
      return { ok: false, status: result.status, error: errBody?.message ?? errBody?.error };
    }
    return { ok: true, status: result.status, result: result.body as BrownfieldLinkResult };
  }

  /** The full notifications matrix for an org. Empty on failure. */
  async notificationMatrix(orgId: string): Promise<NotificationMatrix> {
    const json = await this.getJson<NotificationMatrix>(`/orgs/${encodeURIComponent(orgId)}/notifications/matrix`);
    return json ?? { targets: [], routes: [], events: [] };
  }

  /** Create a notification target. */
  async createNotificationTarget(
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<NotificationTarget | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/notifications/targets`, body);
    if (!result.ok) return undefined;
    return result.body as NotificationTarget;
  }

  /** Create/replace a notification route opt-in. */
  async createNotificationRoute(orgId: string, body: Record<string, unknown>): Promise<NotificationRoute | undefined> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/notifications/routes`, body);
    if (!result.ok) return undefined;
    return result.body as NotificationRoute;
  }

  // ── run-detail / review / SSE ─────────────────────────────────
  // The dashboard route is `/runs/:runId` (the spec permits deriving
  // org/project from the run); the orchestrator API is org+project-scoped, so
  // we resolve the run's location by scanning the operator's orgs + projects
  // for a matching run, then fetch the snapshot.
  // -------------------------------------------------------------------------

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
   * payloads via `?raw=true` (the orchestrator emits the audit
   * trail); the dashboard only sets it for admins. `undefined` when the run
   * is missing or access is denied.
   */
  async getRunDetail(
    loc: RunLocation,
    runId: string,
    opts: { rawView?: boolean } = {},
  ): Promise<RunDetail | undefined> {
    const query = opts.rawView === true ? "?raw=true" : "";
    const response = await this.fetchImpl(
      `${this.orchestratorUrl}/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}${query}`,
      { headers: this.headers(opts.rawView === true ? { "x-view-raw": "true" } : undefined) },
    ).catch(() => {});
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
