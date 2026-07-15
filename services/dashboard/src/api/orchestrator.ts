/**
 * Typed fetch client for the orchestrator product APIs the dashboard shell
 * needs: session (`/auth/me`), orgs, projects, and the Forge tool surface
 * (palette items + write-action invocation).
 *
 * Every request forwards the inbound dashboard request's `cookie` header so the
 * orchestrator can validate the `tanren_session` cookie. List reads return
 * `undefined` (not `[]`) on transport/HTTP/decode failure so callers render an
 * explicit unavailable state rather than laundering failure into empty/zero.
 */

import type { DashboardSession } from "../auth/session.js";
import type { DoraMetrics } from "./dora.js";
import { OrchestratorNotificationsClient } from "./notificationsClient.js";
import { findRunLocation as resolveRunLocation, type FindRunLocationResult } from "./runLocation.js";
import {
  decodeRead,
  FeedListResponseSchema,
  InsightListResponseSchema,
  MilestoneListResponseSchema,
  RunListResponseSchema,
  SpecListResponseSchema,
} from "./readResponseSchemas.js";
import { fetchRunDetail, type RunDetailResult } from "./runDetailClient.js";
import {
  CreatedProjectSchema,
  BrownfieldLinkResultSchema,
  decodeWith,
  ForgeNarrationSchema,
  ForgeThreadSchema,
  RunSummarySchema,
  SpecSummarySchema,
} from "./writeResponseSchemas.js";
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
  OrgSummary,
  PersonaSummary,
  ProjectConfig,
  ProjectDetail,
  ProjectFeedItem,
  ProjectSummary,
  RunListItem,
  RunLocation,
  RunSummary,
  SpecSummary,
} from "./types.js";

export type { OrchestratorClientDeps } from "./httpClient.js";
export type { FindRunLocationResult, RunLocation } from "./runLocation.js";

export type { RunDetailResult } from "./runDetailClient.js";

export class OrchestratorClient extends OrchestratorNotificationsClient {
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

  /**
   * Orgs the operator is a member of. `undefined` on transport/HTTP/parse
   * failure so callers can distinguish an unavailable read from a legitimate
   * empty (unauthenticated) result instead of laundering failure into `[]`.
   */
  async listOrgsMaybe(): Promise<OrgSummary[] | undefined> {
    const json = await this.getJson<{ orgs?: OrgSummary[] }>("/orgs");
    if (json === undefined || !Array.isArray(json.orgs)) return undefined;
    return json.orgs;
  }

  /**
   * Projects in an org the operator can access. `undefined` on
   * transport/HTTP/parse failure so project discovery never looks empty when
   * the orchestrator is actually unreachable.
   */
  async listProjectsMaybe(orgId: string): Promise<ProjectSummary[] | undefined> {
    const json = await this.getJson<{ projects?: ProjectSummary[] }>(`/orgs/${encodeURIComponent(orgId)}/projects`);
    if (json === undefined || !Array.isArray(json.projects)) return undefined;
    return json.projects;
  }

  /**
   * All cost records for a run (`GET .../runs/:runId/costs`), walking the cursor pages
   * until the cursor is exhausted so the costs dashboard sees the FULL set. Progress-
   * based: each page MUST yield a NEW cursor — a repeated cursor means the API stopped
   * advancing, so the walk STOPS on that (returning what it has) rather than looping
   * forever. Reports `complete: false` when any page failed (transport/HTTP/parse) so
   * callers never present a partial total as the full picture.
   */
  async listRunCosts(
    orgId: string,
    projectId: string,
    runId: string,
  ): Promise<{ records: CostRecord[]; complete: boolean }> {
    const base = `${this.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(
      projectId,
    )}/runs/${encodeURIComponent(runId)}/costs`;
    const all: CostRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let complete = true;
    for (;;) {
      const url = cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
      const response = await this.fetchImpl(url, { headers: this.headers() }).catch(() => {});
      if (response === undefined || !response.ok) {
        // The gathered set is partial, not the full picture; surface that.
        complete = false;
        break;
      }
      const json = (await response.json().catch(() => {})) as Partial<CursorPage<CostRecord>> | undefined;
      if (json === undefined) {
        complete = false;
        break;
      }
      for (const item of json.items ?? []) {
        all.push(item);
      }
      const nextCursor = json.nextCursor ?? null;
      // Stop on an exhausted OR non-advancing cursor (a repeated cursor would
      // loop forever). A non-advancing API stops the walk with what it has.
      if (nextCursor === null || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return { records: all, complete };
  }

  /**
   * Invoke a Forge write tool (operator-button action) via
   * `POST /orgs/:orgId/forge/tools`. Returns the raw `{ tool, result }` body or
   * `undefined` on failure (the caller decides how to surface it).
   * Goes through `sendJson` so session CSRF rides on the write.
   */
  async invokeForgeTool(orgId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.sendJson("POST", `/orgs/${encodeURIComponent(orgId)}/forge/tools`, { tool, args });
    if (!result.ok) return undefined;
    return result.body;
  }

  // Product reads/writes below use shared getJson/sendJson. List reads return
  // `undefined` on transport/HTTP/decode failure so callers render an explicit
  // unavailable state rather than laundering failure into an empty/zero result.

  /**
   * Runs for attention queue + KPIs. `undefined` on failure (unavailable,
   * not fake empty/zeros) — callers MUST distinguish that from a legitimate
   * empty 200 response.
   */
  async listRunsMaybe(
    orgId: string,
    projectId: string,
    query: { status?: string; specId?: string } = {},
  ): Promise<RunListItem[] | undefined> {
    const params = new URLSearchParams();
    if (query.status !== undefined && query.status !== "") params.set("status", query.status);
    if (query.specId !== undefined && query.specId !== "") params.set("specId", query.specId);
    const qs = params.toString();
    const json = await this.getJson<unknown>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs${qs ? `?${qs}` : ""}`,
    );
    return decodeRead(RunListResponseSchema, json)?.items;
  }

  /**
   * Project activity feed. `undefined` on transport/HTTP/decode failure so a
   * dead feed is never reported as "no recent activity."
   */
  async listFeedMaybe(orgId: string, projectId: string): Promise<ProjectFeedItem[] | undefined> {
    const json = await this.getJson<unknown>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/feed`,
    );
    return decodeRead(FeedListResponseSchema, json)?.items;
  }

  /**
   * Workflow insights, filtered to the supported kinds (trio plus the
   * `stuck` + `review_stall` and the `ci_flaky` additions).
   * Acknowledged rows drop out. `undefined` on transport/HTTP/decode failure
   * so the needs-attention count never under-counts because of a dead read.
   */
  async listInsightsMaybe(orgId: string, projectId: string): Promise<InsightSummary[] | undefined> {
    const json = await this.getJson<unknown>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/insights`,
    );
    const decoded = decodeRead(InsightListResponseSchema, json);
    if (decoded === undefined) return undefined;
    const supported = new Set(["retry_hotspot", "model_mismatch", "pace_anomaly", "stuck", "review_stall", "ci_flaky"]);
    return decoded.insights.filter((insight) => supported.has(insight.kind) && insight.acknowledgedAt === null);
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

  /**
   * Project milestones for the velocity card + spec form. `undefined` on
   * failure (unavailable, not a fake empty milestone set).
   */
  async listMilestonesMaybe(orgId: string, projectId: string): Promise<MilestoneSummary[] | undefined> {
    const json = await this.getJson<unknown>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones`,
    );
    return decodeRead(MilestoneListResponseSchema, json)?.milestones;
  }

  /**
   * Project specs (spec list + dependency picker). `undefined` on failure
   * (unavailable, not a fake empty DAG).
   */
  async listSpecsMaybe(orgId: string, projectId: string): Promise<SpecSummary[] | undefined> {
    const json = await this.getJson<unknown>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`,
    );
    return decodeRead(SpecListResponseSchema, json)?.specs;
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
      { expectBody: true, decode: (value) => decodeWith(SpecSummarySchema, value) },
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
      { expectBody: true, decode: (value) => decodeWith(RunSummarySchema, value) },
    );
  }

  /**
   * Best-effort Forge project-view narration: create a project
   * thread, generate the templated turn, and return its render payload. Any
   * failure yields `undefined` so the project view degrades to the
   * data-derived attention queue without the narration pulse line.
   *
   * **State-changing** (POST forge threads + turns). Call only from CSRF-
   * protected write paths (e.g. `POST /forge/project-narration`) — never as a
   * side effect of a safe GET page load.
   */
  async generateProjectNarration(
    orgId: string,
    projectId: string,
    budgetUsdPerWeek?: number,
  ): Promise<ForgeAnswer | undefined> {
    const thread = await this.sendJson<{ id: string }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads`,
      {
        scope: "project",
        projectId,
      },
      { expectBody: true, decode: (value) => decodeWith(ForgeThreadSchema, value) },
    );
    const threadId = thread.body?.id;
    if (!thread.ok || threadId === undefined) {
      return undefined;
    }
    const turn = await this.sendJson<{ render: ForgeAnswer }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads/${encodeURIComponent(threadId)}/turns/generate-project-view`,
      budgetUsdPerWeek === undefined ? { projectId } : { projectId, budgetUsdPerWeek },
      { expectBody: true, decode: (value) => decodeWith(ForgeNarrationSchema, value) },
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
    const result = await this.sendJson<CreatedProject>("POST", `/orgs/${encodeURIComponent(orgId)}/projects`, body, {
      expectBody: true,
      decode: (value) => decodeWith(CreatedProjectSchema, value),
    });
    if (!result.ok) return undefined;
    return result.body;
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
    const result = await this.sendJson<BrownfieldLinkResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/link`,
      body,
      { expectBody: true, decode: (value) => decodeWith(BrownfieldLinkResultSchema, value) },
    );
    if (!result.ok) {
      return { ok: false, status: result.status };
    }
    return { ok: true, status: result.status, result: result.body };
  }

  // ── run-detail / review / SSE ─────────────────────────────────
  // The dashboard route is `/runs/:runId` (the spec permits deriving
  // org/project from the run); ask the orchestrator's org-scoped location
  // endpoint rather than listing every project and its runs.
  // -------------------------------------------------------------------------

  /**
   * Resolve which org+project a run belongs to. One org-scoped location probe
   * per visible org — never a project/run-list fan-out. Fail-closed: only a
   * definitive documented 404 body is not-found; network/auth/upstream/malformed
   * /multi-match outcomes are explicit kinds (see `FindRunLocationResult`).
   */
  async findRunLocation(runId: string): Promise<FindRunLocationResult> {
    return resolveRunLocation(
      {
        orchestratorUrl: this.orchestratorUrl,
        headers: this.headers(),
        fetchImpl: this.fetchImpl,
      },
      runId,
    );
  }

  /**
   * Fetch the full run-detail snapshot. `rawView` opts into unredacted
   * payloads via `?raw=true` (the orchestrator emits the audit
   * trail); the dashboard only sets it for admins. `undefined` when the run
   * is missing. Transport, HTTP, JSON, and contract failures are unavailable;
   * they are never laundered into a not-found result.
   */
  async getRunDetail(loc: RunLocation, runId: string, opts: { rawView?: boolean } = {}): Promise<RunDetailResult> {
    return fetchRunDetail(
      { orchestratorUrl: this.orchestratorUrl, headers: this.headers(), fetchImpl: this.fetchImpl },
      loc,
      runId,
      opts,
    );
  }

  /** Build the SSE stream URL for the run's live feed (consumed by the client island). */
  streamUrl(loc: RunLocation, runId: string, opts: { rawView?: boolean } = {}): string {
    const query = opts.rawView === true ? "?raw=true" : "";
    return `${this.orchestratorUrl}/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}/stream${query}`;
  }
}
