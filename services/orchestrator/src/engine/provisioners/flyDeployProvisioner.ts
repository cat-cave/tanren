// FlyDeployProvisioner (P-INT-4) — `IntegrationProvisioner` for provider kind
// `deploy.flyio`. Creates/finds a Fly.io APP under the org grant so the built
// product can be deployed, and captures the preview-URL pattern + a deployment
// ref. All HTTP goes through the injectable `DeployHttpTransport`, so the full
// lifecycle is unit-tested against a scripted fake with NO live Fly calls or
// credentials in CI.
//
// API surface used (Fly Machines REST API):
//   - GET  /v1/apps?org_slug=<org>   → list the org's apps (discover)
//   - POST /v1/apps                  → create an app under the org (provision)
// Org scoping: the org grant's metadata carries `orgSlug` (the Fly org). The org
// grant's `credentialRef` resolves to the Fly API token (a bearer) — resolved by
// the base, never held here.
//
// Preview-URL pattern: a Fly app is reachable at `https://<app-name>.fly.dev`.
// Fly app names are globally unique, so the per-app URL IS the stable pattern
// (no per-deploy wildcard — Fly preview/deploy reuses the app hostname).

import type { OrgGrant, ProjectContext } from "../contracts/integrationProvisioner.js";
import {
  DeployProvisioner,
  type DeployApp,
  type DeployProviderApi,
  type DeployProvisionerDeps,
} from "./deployProvisioner.js";

const FLY_API_BASE = "https://api.machines.dev";
export const FLY_PROVIDER_KIND = "deploy.flyio";

interface FlyApp {
  id?: string;
  name: string;
}

interface FlyAppsListResponse {
  apps?: FlyApp[];
}

/** Read the required Fly org slug from the org grant metadata. */
function orgSlug(grant: OrgGrant): string {
  const value = grant.metadata["orgSlug"];
  if (typeof value !== "string" || value === "") {
    throw new Error("fly deploy provisioner requires `orgSlug` in the org grant metadata");
  }
  return value;
}

/** A Fly app is reachable at `https://<app-name>.fly.dev`. */
function previewUrlPattern(appName: string): string {
  return `https://${appName}.fly.dev`;
}

class FlyDeployApi implements DeployProviderApi {
  readonly providerKind = FLY_PROVIDER_KIND;

  constructor(private readonly transport: DeployProvisionerDeps["transport"]) {}

  async listApps(grant: OrgGrant, token: string): Promise<DeployApp[]> {
    const org = orgSlug(grant);
    const response = await this.transport.request({
      method: "GET",
      url: `${FLY_API_BASE}/v1/apps?org_slug=${encodeURIComponent(org)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`fly list apps failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as FlyAppsListResponse;
    return (body.apps ?? []).map((app) => ({
      // Fly identifies apps by their globally-unique name; `id` is informational.
      appId: app.id ?? app.name,
      name: app.name,
      previewUrlPattern: previewUrlPattern(app.name),
    }));
  }

  async createApp(grant: OrgGrant, token: string, name: string, _projectCtx: ProjectContext): Promise<DeployApp> {
    const org = orgSlug(grant);
    const response = await this.transport.request({
      method: "POST",
      url: `${FLY_API_BASE}/v1/apps`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { app_name: name, org_slug: org },
    });
    if (!response.ok) {
      throw new Error(`fly create app failed: ${response.status} ${response.text}`);
    }
    // Fly's create-app returns 201 with little/no body; the app is keyed by the
    // name we requested, which is the stable handle.
    const created = (response.json ?? {}) as FlyApp;
    const appName = created.name ?? name;
    return {
      appId: created.id ?? appName,
      name: appName,
      previewUrlPattern: previewUrlPattern(appName),
    };
  }
}

/** The Fly.io deploy provisioner (`deploy.flyio`). */
export class FlyDeployProvisioner extends DeployProvisioner {
  constructor(deps: DeployProvisionerDeps) {
    super(new FlyDeployApi(deps.transport), deps);
  }
}
