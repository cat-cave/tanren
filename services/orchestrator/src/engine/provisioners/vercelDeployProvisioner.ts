// VercelDeployProvisioner — `IntegrationProvisioner` for provider kind
// `deploy.vercel`. Creates/finds a Vercel PROJECT under the org's team grant so
// the built product can be deployed, and captures the preview-URL pattern + a
// deployment ref. All HTTP goes through the injectable `DeployHttpTransport`, so
// the full lifecycle is unit-tested against a scripted fake with NO live Vercel
// calls or credentials in CI.
//
// API surface used (Vercel REST):
//   - GET  /v9/projects[?teamId=…]    → list the team's projects (discover)
//   - POST /v9/projects[?teamId=…]    → create a project under the team (provision)
//   - POST /v13/deployments[?teamId=…] → TRIGGER a build + release of a git ref
// Team scoping: the org grant's metadata may carry `teamId` (Vercel team) and/or
// `slug`; when present they are threaded as the `teamId` query param + used to
// shape the preview-URL pattern. The org grant's `credentialRef` resolves to the
// Vercel team token (a bearer) — resolved by the base, never held here.
//
// Preview-URL pattern (CONVERGED on the dashboard's `derivePreviewUrl`): Vercel
// serves a DETERMINISTIC per-branch preview at
//   https://<project>-git-<branch>[-<team-slug>].vercel.app
// We capture that with a `{branch}` placeholder (the same token the dashboard
// substitutes) — NOT a `*` wildcard, which the dashboard could not resolve.
//
// Deploy trigger: `triggerDeploy` POSTs `/v13/deployments` with a `gitSource` in the
// v13 github variant (`{ type:"github", org, repo, ref, sha }` — org=owner, repo=bare
// name, sha=the merged commit), so Vercel pulls the merged commit and builds + releases
// it. It returns the live deployment id + the resolved deployment URL.

import type { OrgGrant, ProjectContext } from "../contracts/integrationProvisioner.js";
import {
  DeployProvisioner,
  type DeployApp,
  type DeployEnvVar,
  type DeploymentStatus,
  type DeployProviderApi,
  type DeployProvisionerDeps,
  type DeployResult,
  type DeploySource,
} from "./deployProvisioner.js";

const VERCEL_API_BASE = "https://api.vercel.com";
export const VERCEL_PROVIDER_KIND = "deploy.vercel";

interface VercelProject {
  id: string;
  name: string;
}

interface VercelProjectsListResponse {
  projects?: VercelProject[];
  /**
   * Continuation-token pagination: `next` is the token to pass as the `from` query
   * param to fetch the next page (null/absent when the list is exhausted). Without
   * following this, a team with more projects than one page returns would HIDE the
   * target app behind the page boundary → a spurious "unknown app" deploy failure.
   */
  pagination?: { next?: number | string | null };
}

// A hard cap on the project-list pages followed, so a pathological pagination loop
// (a provider that never returns a null `next`) fails LOUD rather than spinning forever.
const VERCEL_MAX_PROJECT_PAGES = 100;

/** Read the Vercel team id (if any) from the org grant metadata. */
function teamId(grant: OrgGrant): string | undefined {
  const value = grant.metadata["teamId"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read the Vercel team slug (if any) — shapes the preview-URL pattern. */
function teamSlug(grant: OrgGrant): string | undefined {
  const value = grant.metadata["slug"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Compose the team-scoped Vercel preview-URL pattern for a project. Uses the
 * DETERMINISTIC git-branch preview form (`<project>-git-<branch>-<scope>`) with a
 * `{branch}` placeholder — the SAME token the dashboard's `derivePreviewUrl`
 * substitutes — so a rendered preview URL resolves directly (no `*` wildcard).
 */
function previewUrlPattern(grant: OrgGrant, projectName: string): string {
  const slug = teamSlug(grant);
  const suffix = slug === undefined ? "" : `-${slug}`;
  return `https://${projectName}-git-{branch}${suffix}.vercel.app`;
}

/**
 * Split a `owner/name` repo slug into the Vercel gitSource `org` (owner) + `repo`
 * (bare name). The v13 github gitSource variant requires the owner and the bare
 * repo name as SEPARATE fields — passing the full `owner/name` as `repo` is the
 * shape Vercel rejects. A slug without exactly one `/` is a wiring bug — fail LOUD.
 */
function splitRepoSlug(slug: string): { org: string; name: string } {
  const parts = slug.split("/");
  const org = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || org === undefined || org === "" || name === undefined || name === "") {
    throw new Error(`vercel deploy: repo slug '${slug}' is not a valid 'owner/name' (cannot build the gitSource)`);
  }
  return { org, name };
}

/** Append `teamId=` when the grant carries a team id (joined with `&` if the path already has a query). */
function scoped(grant: OrgGrant, path: string): string {
  const team = teamId(grant);
  const url = `${VERCEL_API_BASE}${path}`;
  if (team === undefined) {
    return url;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${url}${sep}teamId=${encodeURIComponent(team)}`;
}

class VercelDeployApi implements DeployProviderApi {
  readonly providerKind = VERCEL_PROVIDER_KIND;

  constructor(private readonly transport: DeployProvisionerDeps["transport"]) {}

  async listApps(grant: OrgGrant, token: string): Promise<DeployApp[]> {
    // PAGINATED: follow `pagination.next` (passed back as the `from` query token) across
    // every page so a team with more projects than one page returns is fully listed —
    // an unpaginated single page would HIDE the target app and yield a spurious "unknown
    // app" deploy failure. Bounded by VERCEL_MAX_PROJECT_PAGES (fail LOUD, never spin).
    const apps: DeployApp[] = [];
    let from: string | undefined;
    for (let page = 0; page < VERCEL_MAX_PROJECT_PAGES; page++) {
      const path = from === undefined ? "/v9/projects" : `/v9/projects?from=${encodeURIComponent(from)}`;
      const response = await this.transport.request({
        method: "GET",
        url: scoped(grant, path),
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`vercel list projects failed: ${response.status} ${response.text}`);
      }
      const body = (response.json ?? {}) as VercelProjectsListResponse;
      for (const project of body.projects ?? []) {
        apps.push({
          appId: project.id,
          name: project.name,
          previewUrlPattern: previewUrlPattern(grant, project.name),
        });
      }
      const next = body.pagination?.next;
      if (next === undefined || next === null || next === "") {
        return apps;
      }
      from = String(next);
    }
    throw new Error(
      `vercel list projects: exceeded ${String(VERCEL_MAX_PROJECT_PAGES)} pages (pagination did not terminate)`,
    );
  }

  async createApp(grant: OrgGrant, token: string, name: string, _projectCtx: ProjectContext): Promise<DeployApp> {
    const response = await this.transport.request({
      method: "POST",
      url: scoped(grant, "/v9/projects"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { name },
    });
    if (!response.ok) {
      throw new Error(`vercel create project failed: ${response.status} ${response.text}`);
    }
    const project = response.json as VercelProject | undefined;
    if (project?.id === undefined || project.name === undefined) {
      throw new Error(`vercel create project returned no id/name: ${response.text}`);
    }
    return {
      appId: project.id,
      name: project.name,
      previewUrlPattern: previewUrlPattern(grant, project.name),
    };
  }

  async setEnvVars(grant: OrgGrant, token: string, appId: string, vars: ReadonlyArray<DeployEnvVar>): Promise<void> {
    // Vercel env upsert: POST /v10/projects/{id}/env with `?upsert=true` so a
    // re-attach updates the existing var rather than 409ing on a duplicate key.
    // `target: ["production"]` scopes the var to the deployed (production) runtime
    // — the runtime-scoped App-Environment entries map to the production deploy.
    for (const variable of vars) {
      const response = await this.transport.request({
        method: "POST",
        url: scoped(grant, `/v10/projects/${encodeURIComponent(appId)}/env?upsert=true`),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { key: variable.key, value: variable.value, type: "encrypted", target: ["production"] },
      });
      if (!response.ok) {
        // The error text is provider-supplied (status + provider message); the
        // VALUE we sent is never interpolated into the thrown message.
        throw new Error(`vercel set env '${variable.key}' failed: ${response.status} ${response.text}`);
      }
    }
  }

  async triggerDeploy(grant: OrgGrant, token: string, app: DeployApp, source: DeploySource): Promise<DeployResult> {
    // POST /v13/deployments with a `gitSource` so Vercel pulls the MERGED commit and
    // builds + releases it. `name` ties the deployment to the existing project;
    // `target: production` releases it as the live deploy. Vercel returns the
    // deployment id + the resolved deployment URL.
    //
    // gitSource shape (v13 github variant, per the live REST reference): the github
    // variant is `{ type:"github", org, repo, ref, sha }` — `org` is the repo OWNER,
    // `repo` is the BARE repo name (NOT `owner/name`), `ref` the branch/ref, and the
    // COMMIT goes in `sha`. The merged source's `repo` is the `owner/name` slug, so we
    // split it into `org`/`repo`. The merged commit SHA pins the exact build: it is set
    // as `sha` AND as `ref` (Vercel accepts a SHA as a ref; the run's PR branch is
    // squash-deleted, so the SHA is the only durable handle to the merged commit).
    const { org, name: repoName } = splitRepoSlug(source.repo);
    const response = await this.transport.request({
      method: "POST",
      url: scoped(grant, "/v13/deployments"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: {
        name: app.name,
        project: app.appId,
        target: "production",
        gitSource: { type: "github", org, repo: repoName, ref: source.ref, sha: source.ref },
      },
    });
    if (!response.ok) {
      throw new Error(`vercel trigger deploy for '${app.appId}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { id?: string; url?: string; readyState?: string; status?: string };
    if (body.id === undefined || body.url === undefined) {
      throw new Error(`vercel trigger deploy for '${app.appId}' returned no id/url: ${response.text}`);
    }
    // Vercel's `url` is the bare host (no scheme); normalize to an https origin so
    // the resolved URL is directly renderable.
    const url = body.url.startsWith("http") ? body.url : `https://${body.url}`;
    return { deploymentId: body.id, url, state: body.readyState ?? body.status ?? "QUEUED" };
  }

  async getDeployment(
    grant: OrgGrant,
    token: string,
    _app: DeployApp,
    deploymentId: string,
  ): Promise<DeploymentStatus> {
    // GET /v13/deployments/{id} → the deployment's `readyState` (Vercel's lifecycle:
    // QUEUED → BUILDING → READY, or ERROR / CANCELED on failure). The verify poll
    // collapses that into the ready/failed terminals it waits on.
    const response = await this.transport.request({
      method: "GET",
      url: scoped(grant, `/v13/deployments/${encodeURIComponent(deploymentId)}`),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`vercel get deployment '${deploymentId}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { url?: string; readyState?: string; status?: string };
    const state = body.readyState ?? body.status ?? "QUEUED";
    const host = body.url ?? "";
    const url = host === "" ? "" : host.startsWith("http") ? host : `https://${host}`;
    return {
      state,
      terminalReady: state === "READY",
      terminalFailed: state === "ERROR" || state === "CANCELED",
      url,
    };
  }
}

/** The Vercel deploy provisioner (`deploy.vercel`). */
export class VercelDeployProvisioner extends DeployProvisioner {
  constructor(deps: DeployProvisionerDeps) {
    super(new VercelDeployApi(deps.transport), deps);
  }
}
