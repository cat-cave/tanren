// FlyDeployProvisioner — `IntegrationProvisioner` for provider kind
// `deploy.flyio`. Creates/finds a Fly.io APP under the org grant so the built
// product can be deployed, and captures the preview-URL pattern + a deployment
// ref. All HTTP goes through the injectable `DeployHttpTransport`, so the full
// lifecycle is unit-tested against a scripted fake with NO live Fly calls or
// credentials in CI.
//
// API surface used (Fly Machines REST API):
//   - GET  /v1/apps?org_slug=<org>      → list the org's apps (discover)
//   - POST /v1/apps                     → create an app under the org (provision)
//   - POST /v1/apps/{app}/machines      → TRIGGER a release (run the app's image)
// Org scoping: the org grant's metadata carries `orgSlug` (the Fly org). The org
// grant's `credentialRef` resolves to the Fly API token (a bearer) — resolved by
// the base, never held here. The app's deploy IMAGE is read from the grant
// metadata (`image`, e.g. a registry ref the build published) when present.
//
// Preview-URL pattern: a Fly app is reachable at `https://<app-name>.fly.dev`.
// Fly app names are globally unique, so the per-app URL IS the stable pattern (no
// `{branch}`/`{pr}` placeholder — Fly serves one stable hostname per app, which the
// dashboard's `derivePreviewUrl` renders verbatim).
//
// Deploy trigger: `triggerDeploy` POSTs `/v1/apps/{app}/machines` to create + run a
// machine from the app's image — the Machines-API release equivalent of `fly deploy`
// — and returns the machine id + the app's stable URL + its reported state.
//
// ⚠ NOT MERGE-REFLECTING (apex guard): this arm releases a STATIC image from the grant
// metadata (`image`) — it IGNORES the merged source (`DeploySource`), spins a NEW machine
// per trigger, and wires NO port mapping. So a Fly release does NOT prove "the live
// product reflects THIS merge" — the image is whatever the build last published, not the
// merged commit. apex's live-reflects-merge proof MUST run on `deploy.vercel` (gitSource =
// the merged commit). To prevent a Fly release from being mistaken for a merge-reflecting
// deploy, `triggerDeploy` FAILS LOUD unless `TANREN_ALLOW_FLY_STATIC_DEPLOY=1` explicitly
// acknowledges the static-image semantics. Making Fly merge-reflecting (build-from-source +
// port mapping + image-per-commit) is deferred — it is a build-pipeline change, not a patch.

import { parsedEnv } from "../../envSchema.js";
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

/**
 * Read the deploy IMAGE the Machines release runs. A Fly release needs an image ref
 * (the registry image the build published); the org grant carries it as `image`. A
 * deploy with no image to release is a misconfiguration — fail LOUD, never a silent
 * empty release.
 */
function deployImage(grant: OrgGrant): string {
  const value = grant.metadata["image"];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "fly deploy provisioner requires an `image` in the org grant metadata to release (the built app's registry image)",
    );
  }
  return value;
}

/** A Fly app is reachable at `https://<app-name>.fly.dev`. */
function previewUrlPattern(appName: string): string {
  return `https://${appName}.fly.dev`;
}

class FlyDeployApi implements DeployProviderApi {
  readonly providerKind = FLY_PROVIDER_KIND;

  constructor(
    private readonly transport: DeployProvisionerDeps["transport"],
    private readonly allowStaticDeploy: boolean,
  ) {}

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

  async setEnvVars(_grant: OrgGrant, token: string, appId: string, vars: ReadonlyArray<DeployEnvVar>): Promise<void> {
    // Fly app secrets: POST /v1/apps/{app_name}/secrets sets the app's runtime
    // environment in ONE call (`secrets: { KEY: value }`). Fly keys an app by its
    // globally-unique name, which is the `appId` carried on the deployRef. The
    // values are sent as the app's secrets — and travel ONLY in this request body.
    const secretsBody: Record<string, string> = {};
    for (const variable of vars) {
      secretsBody[variable.key] = variable.value;
    }
    const response = await this.transport.request({
      method: "POST",
      url: `${FLY_API_BASE}/v1/apps/${encodeURIComponent(appId)}/secrets`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { secrets: secretsBody },
    });
    if (!response.ok) {
      // Only env-var KEYS reach the error message (never the values).
      const keys = vars.map((variable) => variable.key).join(", ");
      throw new Error(`fly set secrets [${keys}] on '${appId}' failed: ${response.status} ${response.text}`);
    }
  }

  async triggerDeploy(grant: OrgGrant, token: string, app: DeployApp, _source: DeploySource): Promise<DeployResult> {
    // NOT MERGE-REFLECTING GUARD: this releases a STATIC `image` and ignores the merged
    // `_source`, so it cannot prove "the live product reflects this merge". Fail LOUD
    // unless the operator explicitly opts into the static-image semantics — so apex
    // never accidentally "proves" deploy on Fly (it must use `deploy.vercel`). See header.
    if (!this.allowStaticDeploy) {
      throw new Error(
        "fly deploy is NOT merge-reflecting (it releases a static image, ignores the merged source) — " +
          "it cannot prove 'the live product reflects this merge'. Use `deploy.vercel` for that, or set " +
          "TANREN_ALLOW_FLY_STATIC_DEPLOY=1 to explicitly accept the static-image semantics.",
      );
    }
    // POST /v1/apps/{app}/machines creates + runs a machine from the built image —
    // the Machines-API release equivalent of `fly deploy`. Fly keys an app by its
    // globally-unique NAME in the path (`app.name`). The app URL is its stable
    // hostname.
    const image = deployImage(grant);
    const response = await this.transport.request({
      method: "POST",
      url: `${FLY_API_BASE}/v1/apps/${encodeURIComponent(app.name)}/machines`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { config: { image } },
    });
    if (!response.ok) {
      throw new Error(`fly trigger deploy for '${app.name}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { id?: string; state?: string };
    if (body.id === undefined) {
      throw new Error(`fly trigger deploy for '${app.name}' returned no machine id: ${response.text}`);
    }
    return { deploymentId: body.id, url: previewUrlPattern(app.name), state: body.state ?? "started" };
  }

  async getDeployment(
    _grant: OrgGrant,
    token: string,
    app: DeployApp,
    deploymentId: string,
  ): Promise<DeploymentStatus> {
    // GET /v1/apps/{app}/machines/{id} → the machine's `state` (Fly's lifecycle:
    // created → starting → started, or stopped / failed / destroyed on failure). The
    // app's stable hostname IS the deployment URL (one host per app). The verify poll
    // collapses the state into its ready/failed terminals.
    const response = await this.transport.request({
      method: "GET",
      url: `${FLY_API_BASE}/v1/apps/${encodeURIComponent(app.name)}/machines/${encodeURIComponent(deploymentId)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`fly get machine '${deploymentId}' on '${app.name}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { state?: string };
    const state = body.state ?? "created";
    return {
      state,
      terminalReady: state === "started",
      terminalFailed: state === "stopped" || state === "failed" || state === "destroyed",
      url: previewUrlPattern(app.name),
    };
  }
}

/** The Fly.io deploy provisioner (`deploy.flyio`). */
export class FlyDeployProvisioner extends DeployProvisioner {
  // The static-image opt-in is a boot-time env knob (TANREN_ALLOW_FLY_STATIC_DEPLOY,
  // parsed once by envSchema.ts). It flows in via the injected deps — defaulting to
  // the parsed env when the deps omit it (callers/tests may set it explicitly).
  constructor(deps: DeployProvisionerDeps) {
    const allowStaticDeploy = deps.allowFlyStaticDeploy ?? parsedEnv.TANREN_ALLOW_FLY_STATIC_DEPLOY === "1";
    super(new FlyDeployApi(deps.transport, allowStaticDeploy), deps);
  }
}
