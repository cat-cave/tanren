// FlyDeployProvisioner — `IntegrationProvisioner` for provider kind
// `deploy.flyio`. Creates/finds a Fly.io APP under the org grant so the built
// product can be deployed, and captures the preview-URL pattern + a deployment
// ref. All HTTP goes through the injectable `DeployHttpTransport`, so the full
// lifecycle is unit-tested against a scripted fake with NO live Fly calls or
// credentials in CI.
//
// NAMESPACING (task #27): every app this provisioner creates is named
// `<tanrenOrgSlug>-<projectName>` (see `deployAppName` in `deployProvisioner.ts`).
// Fly app names live in a GLOBAL namespace across all Fly customers, so a bare
// `linkly` collides on common words → HTTP 422 "Name has already been taken",
// halting onboarding loud. The prefix makes collisions within an org structurally
// impossible, and reduces them to "two different orgs reusing the same name"
// (both succeed — each under its own prefix). A 422 AFTER prefixing is a real
// conflict (re-derive race within the same org) and FAILS LOUD here — there is
// no automatic suffix-retry, no "try without prefix" fallback. The Tanren org
// slug is required on `ProjectContext.orgSlug` (resolved by `provisioningEngine`
// via `OrganizationsStore.getLogin` before this provisioner is called).
//
// API surface used (Fly Machines REST API):
//   - GET  /v1/apps?org_slug=<org>      → list the org's apps (discover)
//   - POST /v1/apps                     → create an app under the org (provision)
//   - POST /v1/apps/{app}/machines      → TRIGGER a release (run the app's image)
// And the Fly GraphQL API (https://api.fly.io/graphql) for IP allocation — the Machines
// REST *release* path does not allocate IPs (the `allocateIpAddress` GraphQL mutation is
// the surface used here; the Machines REST `ip_assignments` endpoint is an alternative):
//   - mutation allocateIpAddress        → allocate the app's shared IPv4 (so <app>.fly.dev
//                                         routes). Idempotent: shared_v4 is one-per-app, so
//                                         a duplicate "already has a shared IPv4" error is
//                                         swallowed. Called from triggerDeploy (all paths).
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
// per trigger. It DOES wire port mapping (edge 80/443 → internal_port 3000) + allocate a
// shared IPv4 so `<app>.fly.dev` routes — but the image is whatever the build last
// published, NOT the merged commit. So a Fly release does NOT prove "the live product
// reflects THIS merge". apex's live-reflects-merge proof MUST run on `deploy.vercel`
// (gitSource = the merged commit). To prevent a Fly release from being mistaken for a
// merge-reflecting deploy, `triggerDeploy` FAILS LOUD unless
// `TANREN_ALLOW_FLY_STATIC_DEPLOY=1` explicitly acknowledges the static-image semantics.
// Making Fly merge-reflecting (build-from-source + image-per-commit) is deferred — it is a
// build-pipeline change, not a patch.

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
// The Fly GraphQL API — the ONLY surface that allocates app IP addresses (the Machines
// REST API does not). Used right after app creation to give the app a shared IPv4 so
// `https://<app>.fly.dev` routes.
const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
export const FLY_PROVIDER_KIND = "deploy.flyio";

interface FlyApp {
  id?: string;
  name: string;
}

interface FlyAppsListResponse {
  apps?: FlyApp[];
}

/**
 * The Fly Machines release config for a static-image deploy: the image, the shared
 * guest size, the TCP service that maps edge ports 80/443 → `internal_port` 3000
 * (matching `fly.toml`'s internal_port so `<app>.fly.dev` routes to the app), and an
 * HTTP health check on `/`. Extracted as a pure helper so the release body is assertable
 * directly in the test (and a later build-from-source PR can swap the image source without
 * touching the port mapping).
 */
export function flyMachineConfig(image: string): Record<string, unknown> {
  return {
    image,
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
    services: [
      {
        protocol: "tcp",
        internal_port: 3000,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
      },
    ],
    checks: {
      httpget: {
        type: "http",
        port: 3000,
        method: "get",
        path: "/",
        interval: "15s",
        // eslint-disable-next-line no-inline-comments — the inline arch-allow bless is required: the arch scanner's `timeout:` pattern is single-line (no multi-line lookahead), so the annotation must ride the same raw line.
        timeout: "10s", // arch-allow: timeout-class — Fly Machines HTTP health-check per-probe bound (API config field sent to Fly, not a JS timer / wall-clock deadline on a running command)
        grace_period: "10s",
      },
    },
  };
}

/**
 * Matches ONLY a Fly GraphQL "shared IPv4 already allocated" duplicate error — the desired
 * end state of an idempotent re-allocation, which `allocateSharedIpv4` swallows. The match
 * REQUIRES both "already" and a shared-v4 phrase to co-occur, so a genuine failure that
 * merely contains "already" — e.g. "already reached your IP allocation limit" (a QUOTA
 * error where NO IP was allocated) — does NOT match and throws LOUD. Fly's duplicate
 * message is "App already has a shared IPv4 address"; a non-IP error (e.g. "not authorized")
 * also does not match.
 */
const ALREADY_ALLOCATED_RE = /(already\b.*shared[\s_-]*(?:ipv4|v4|ip)|shared[\s_-]*(?:ipv4|v4)\b.*already)/iu;

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
      // 422 "Name has already been taken" on an ALREADY-NAMESPACED name (task #27)
      // means the same Tanren org tried to provision the same projectName twice —
      // itself an idempotency/race bug on the derive side (the engine also
      // list-then-create-keyed-on-name; see `DeployProvisioner.provision`). DO NOT
      // silently suffix-retry: that hides the real conflict and lets two races each
      // create a not-quite-the-same app. HALT LOUD instead — the action is to re-
      // derive with a distinct project name OR fix the upstream race.
      if (response.status === 422) {
        throw new Error(
          `fly create app '${name}' failed (422): ${response.text}. The deploy-app namespacing rule ` +
            `(task #27) already prefixed this name with the org slug, so a 422 here means a re-derive ` +
            `race within the SAME org under the SAME project name (re-derive with a distinct project name) ` +
            `OR a stale Fly app the discover step missed. NOT a fallback: there is no automatic suffix-retry.`,
        );
      }
      throw new Error(`fly create app failed: ${response.status} ${response.text}`);
    }
    // Fly's create-app returns 201 with little/no body; the app is keyed by the
    // name we requested, which is the stable handle.
    const created = (response.json ?? {}) as FlyApp;
    const appName = created.name ?? name;
    // NOTE: shared-IPv4 allocation is deliberately NOT done here. Allocating inside
    // createApp would (a) ORPHAN the just-created Fly app if allocation throws before
    // `provision()` returns — the derive destroy-compensation is registered only AFTER
    // this returns — and (b) SKIP brownfield / `bind()` apps that reuse an existing app
    // without calling createApp. Allocation lives in `triggerDeploy` instead: it runs on
    // EVERY deploy path, after the app + its compensation exist, and is idempotent.
    return {
      appId: created.id ?? appName,
      name: appName,
      previewUrlPattern: previewUrlPattern(appName),
    };
  }

  /**
   * Allocate the app's shared IPv4 (Fly GraphQL `allocateIpAddress` mutation) so
   * `https://<app>.fly.dev` routes — the Machines REST release path does not do this.
   * Called from `triggerDeploy` (every deploy path), so it MUST be idempotent: a shared_v4
   * is one-per-app, so a duplicate "already has a shared IPv4" error is the desired end
   * state and is swallowed — but ONLY when EVERY returned GraphQL error is a duplicate (a
   * mixed batch with any auth/quota error throws), a non-2xx throws, and a malformed 2xx
   * (no `data.allocateIpAddress` AND no errors) throws — never a silent "assumed allocated".
   * The token is used ONLY as a bearer — NEVER interpolated into an error/log string (only
   * the app name reaches the message), mirroring this file's "only KEYS in errors" discipline.
   */
  private async allocateSharedIpv4(appName: string, token: string): Promise<void> {
    const response = await this.transport.request({
      method: "POST",
      url: FLY_GRAPHQL_URL,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: {
        query:
          "mutation($input: AllocateIPAddressInput!){ allocateIpAddress(input:$input){ ipAddress { id address type } } }",
        variables: { input: { appId: appName, type: "shared_v4" } },
      },
    });
    if (!response.ok) {
      throw new Error(`fly allocate shared IPv4 for '${appName}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as {
      data?: { allocateIpAddress?: unknown };
      errors?: Array<{ message?: string }>;
    };
    const errors = body.errors ?? [];
    if (errors.length === 0) {
      // A well-formed success carries `data.allocateIpAddress`. A 2xx with neither that nor
      // any errors (e.g. `{}` / non-JSON) is malformed — throw rather than assume allocated.
      const allocated = body.data?.allocateIpAddress;
      if (allocated !== undefined && allocated !== null) {
        return;
      }
      throw new Error(
        `fly allocate shared IPv4 for '${appName}' failed: malformed GraphQL 2xx (no allocateIpAddress, no errors)`,
      );
    }
    // Idempotent ONLY when EVERY error is a shared-v4 duplicate. A mixed batch (a duplicate
    // AND an auth/quota error) means the allocation did NOT succeed → throw LOUD.
    if (errors.every((error) => ALREADY_ALLOCATED_RE.test(error.message ?? ""))) {
      return;
    }
    const messages = errors.map((error) => error.message ?? "").join("; ");
    throw new Error(`fly allocate shared IPv4 for '${appName}' failed: ${messages}`);
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
    // Ensure the app has a shared IPv4 so `https://<app>.fly.dev` routes. Idempotent, and
    // runs on EVERY deploy path (greenfield, brownfield-reuse, `bind()`) — unlike createApp,
    // which greenfield-only apps hit. Done BEFORE the machine release so a live machine is
    // never left routing-less.
    await this.allocateSharedIpv4(app.name, token);
    // POST /v1/apps/{app}/machines creates + runs a machine from the built image —
    // the Machines-API release equivalent of `fly deploy`. Fly keys an app by its
    // globally-unique NAME in the path (`app.name`). The config carries the full
    // release shape (image + guest + port-mapped services + an HTTP check) via
    // `flyMachineConfig` so the machine is reachable at the app's stable hostname.
    const image = deployImage(grant);
    const response = await this.transport.request({
      method: "POST",
      url: `${FLY_API_BASE}/v1/apps/${encodeURIComponent(app.name)}/machines`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { config: flyMachineConfig(image) },
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

  async destroyApp(_grant: OrgGrant, token: string, app: DeployApp): Promise<void> {
    // DELETE /v1/apps/{name} — Fly's app-destroy. IDEMPOTENT per the task #78
    // compensation contract: 404 ⇒ the app is already gone (success). Other
    // failures propagate LOUD so the compensation walker records the rollback
    // gap. Fly keys an app by its globally-unique NAME in the path.
    const response = await this.transport.request({
      method: "DELETE",
      url: `${FLY_API_BASE}/v1/apps/${encodeURIComponent(app.name)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) {
      return;
    }
    throw new Error(`fly destroy app '${app.name}' failed: ${response.status} ${response.text}`);
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
