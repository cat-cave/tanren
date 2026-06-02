// VercelDeployProvisioner (P-INT-4) — `IntegrationProvisioner` for provider kind
// `deploy.vercel`. Creates/finds a Vercel PROJECT under the org's team grant so
// the built product can be deployed, and captures the preview-URL pattern + a
// deployment ref. All HTTP goes through the injectable `DeployHttpTransport`, so
// the full lifecycle is unit-tested against a scripted fake with NO live Vercel
// calls or credentials in CI.
//
// API surface used (Vercel REST v9):
//   - GET  /v9/projects[?teamId=…]   → list the team's projects (discover)
//   - POST /v9/projects[?teamId=…]   → create a project under the team (provision)
// Team scoping: the org grant's metadata may carry `teamId` (Vercel team) and/or
// `slug`; when present they are threaded as the `teamId` query param + used to
// shape the preview-URL pattern. The org grant's `credentialRef` resolves to the
// Vercel team token (a bearer) — resolved by the base, never held here.
//
// Preview-URL pattern: Vercel preview deploys resolve at
//   https://<project>-<deployment-hash>[-<team-slug>].vercel.app
// We capture that as a template with a `*` wildcard for the per-deploy hash, the
// stable part the runtime deploy surface needs to build a preview URL.

import type { OrgGrant, ProjectContext } from "../contracts/integrationProvisioner.js";
import {
  DeployProvisioner,
  type DeployApp,
  type DeployProviderApi,
  type DeployProvisionerDeps,
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

/** Compose the team-scoped Vercel preview-URL pattern for a project. */
function previewUrlPattern(grant: OrgGrant, projectName: string): string {
  const slug = teamSlug(grant);
  const suffix = slug === undefined ? "" : `-${slug}`;
  // `*` stands for the per-deployment hash Vercel injects on each preview.
  return `https://${projectName}-*${suffix}.vercel.app`;
}

/** Append `?teamId=` when the grant carries a team id. */
function scoped(grant: OrgGrant, path: string): string {
  const team = teamId(grant);
  const url = `${VERCEL_API_BASE}${path}`;
  return team === undefined ? url : `${url}?teamId=${encodeURIComponent(team)}`;
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
}

/** The Vercel deploy provisioner (`deploy.vercel`). */
export class VercelDeployProvisioner extends DeployProvisioner {
  constructor(deps: DeployProvisionerDeps) {
    super(new VercelDeployApi(deps.transport), deps);
  }
}
