// VercelDeployProvisioner (P-INT-4) — `IntegrationProvisioner` for provider kind
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
// Deploy trigger: `triggerDeploy` POSTs `/v13/deployments` with a `gitSource`
// pointing at the merged repo + ref, so Vercel pulls the merged commit and builds
// + releases it. It returns the live deployment id + the resolved deployment URL.

import type { OrgGrant, ProjectContext } from "../contracts/integrationProvisioner.js";
import {
  DeployProvisioner,
  type DeployApp,
  type DeployEnvVar,
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
}

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
    const response = await this.transport.request({
      method: "GET",
      url: scoped(grant, "/v9/projects"),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`vercel list projects failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as VercelProjectsListResponse;
    return (body.projects ?? []).map((project) => ({
      appId: project.id,
      name: project.name,
      previewUrlPattern: previewUrlPattern(grant, project.name),
    }));
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
    // POST /v13/deployments with a `gitSource` so Vercel pulls the MERGED commit
    // (the repo + ref) and builds + releases it. `name` ties the deployment to the
    // existing project; `target: production` releases it as the live deploy. Vercel
    // returns the deployment id + the resolved deployment URL.
    const response = await this.transport.request({
      method: "POST",
      url: scoped(grant, "/v13/deployments"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: {
        name: app.name,
        project: app.appId,
        target: "production",
        gitSource: { type: "github", repo: source.repo, ref: source.ref },
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
}

/** The Vercel deploy provisioner (`deploy.vercel`). */
export class VercelDeployProvisioner extends DeployProvisioner {
  constructor(deps: DeployProvisionerDeps) {
    super(new VercelDeployApi(deps.transport), deps);
  }
}
