// The shared shape of the deploy IntegrationProvisioners (P-INT-4): Vercel + Fly.
// A deploy provisioner creates the deploy app/project under the org/team grant so
// the built product can be deployed (unblocks apex's live-preview-deploy). Both
// providers share the same lifecycle — discover (list existing apps) / provision
// (idempotent find-or-create) / bind (link an existing app) — and the same
// artifact wiring (a `deployRef` + a `previewUrlPattern` in projectConfig + a
// deploy-token-scoped secret ref). Only the provider-specific HTTP shape differs,
// so the per-provider subclass implements just the three small primitives below.
//
// SCOPE: this creates the app + captures the deploy ref + preview-URL pattern and
// leaves a CLEAN SEAM (`envAttachmentRef`) for attaching the app's RUNTIME env
// vars — that attachment is P-APP-ENV-2 (Plane B), explicitly OUT of scope here.
//
// Secret handling: the deploy TOKEN is the org grant's `credentialRef` (already in
// the SecretStore). `provision`/`bind` mint a per-app, deploy-scoped ALIAS ref
// that points the runtime deploy adapter at that same credential, scoped to the
// created app. The artifact carries ONLY that ref — never the token value.

import type { SecretStore } from "../contracts/secretStore.js";
import type {
  CapabilityId,
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../contracts/integrationProvisioner.js";
import type { DeployHttpTransport } from "./deployTransport.js";

/** Dependencies every deploy provisioner runs over (injectable for unit tests). */
export interface DeployProvisionerDeps {
  /** The HTTP transport against the provider API (scripted fake in tests). */
  transport: DeployHttpTransport;
  /**
   * Secret store the deploy-scoped token alias is written into. The org grant's
   * `credentialRef` is resolved from here; the per-app alias points back at it.
   */
  secrets: SecretStore;
}

/**
 * A provider-side deploy app/project: the stable handle (`appId`), the human
 * `name` used both as the brownfield label and as the find-or-create idempotency
 * key, and the `previewUrlPattern` the provider exposes for preview deploys.
 */
export interface DeployApp {
  appId: string;
  name: string;
  previewUrlPattern: string;
}

/**
 * The provider-specific HTTP primitives. The base class drives find-or-create,
 * bind, discover, and artifact assembly on top of these three; a new deploy
 * provider implements only this surface (Vercel / Fly do today).
 */
export interface DeployProviderApi {
  /** The provider kind this API speaks for (`deploy.vercel` | `deploy.flyio`). */
  readonly providerKind: string;
  /** List the org/team's existing deploy apps/projects (brownfield discover). */
  listApps(grant: OrgGrant, token: string): Promise<DeployApp[]>;
  /** Create one app/project under the team. Caller has already checked it is absent. */
  createApp(grant: OrgGrant, token: string, name: string, projectCtx: ProjectContext): Promise<DeployApp>;
}

/**
 * Sanitize a Tanren project name into a stable provider app/project name. Lower-
 * cased, non-alphanumerics collapsed to `-`, trimmed — so the SAME project always
 * maps to the SAME app name (the idempotency key find-or-create keys on). Mirrors
 * the `tanren-${runId}` sanitization the Hetzner allocator uses.
 */
export function deployAppName(projectCtx: ProjectContext): string {
  const base = projectCtx.name ?? projectCtx.projectId;
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return slug === "" ? `tanren-${projectCtx.projectId}` : slug;
}

/**
 * The base deploy provisioner. Implements the IntegrationProvisioner contract over
 * a {@link DeployProviderApi}: capability is always `["deploy"]`; provision is
 * idempotent find-or-create keyed on {@link deployAppName}; bind links an existing
 * app by id; the artifact carries the `deployRef` + preview-URL pattern + the
 * deploy-token-scoped secret ref (never the token value) + a clean env-attach seam.
 */
export abstract class DeployProvisioner implements IntegrationProvisioner {
  protected readonly transport: DeployHttpTransport;
  private readonly secrets: SecretStore;

  protected constructor(
    private readonly api: DeployProviderApi,
    deps: DeployProvisionerDeps,
  ) {
    this.transport = deps.transport;
    this.secrets = deps.secrets;
  }

  capability(): CapabilityId[] {
    return ["deploy"];
  }

  async discover(grant: OrgGrant): Promise<ExistingResource[]> {
    const token = await this.resolveToken(grant);
    const apps = await this.api.listApps(grant, token);
    return apps.map((app) => ({
      id: app.appId,
      label: app.name,
      metadata: { previewUrlPattern: app.previewUrlPattern, provider: this.api.providerKind },
    }));
  }

  async provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const token = await this.resolveToken(grant);
    const name = deployAppName(projectCtx);
    // Find-or-create: re-running onboarding must NEVER create a second app. We
    // list first and reuse the stable-named match rather than blindly creating.
    const existing = (await this.api.listApps(grant, token)).find((app) => app.name === name);
    const app = existing ?? (await this.api.createApp(grant, token, name, projectCtx));
    return this.artifactFor(grant, app);
  }

  async bind(grant: OrgGrant, existingResourceId: string, _projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const token = await this.resolveToken(grant);
    const app = (await this.api.listApps(grant, token)).find((candidate) => candidate.appId === existingResourceId);
    if (app === undefined) {
      throw new Error(
        `${this.api.providerKind}: cannot bind unknown deploy app '${existingResourceId}' (not found under the org grant)`,
      );
    }
    return this.artifactFor(grant, app);
  }

  /**
   * Resolve the org grant's deploy token from the SecretStore. The VALUE never
   * leaves this method (it is handed straight to the transport as a bearer); it is
   * never placed in an artifact, logged, or returned.
   */
  private async resolveToken(grant: OrgGrant): Promise<string> {
    const secret = await this.secrets.get(grant.credentialRef);
    if (secret === undefined) {
      throw new Error(
        `${this.api.providerKind}: org grant credentialRef '${grant.credentialRef}' is not present in the secret store`,
      );
    }
    return secret.value;
  }

  /**
   * Assemble the uniform artifact for a created/bound app: the `deployRef` (+
   * preview-URL pattern), the non-secret projectConfig, and a per-app deploy-token
   * ALIAS ref (a pointer to the org credential, NOT the value). The alias makes the
   * runtime deploy adapter resolve the right scoped token without re-deriving the
   * org grant. `envAttachmentRef` is the clean seam P-APP-ENV-2 attaches the app's
   * runtime env vars onto — left unpopulated here by design.
   */
  private async artifactFor(grant: OrgGrant, app: DeployApp): Promise<ProvisionedArtifact> {
    const tokenAliasRef = `secret://deploy/${this.api.providerKind}/${app.appId}/token`;
    // The alias points at the org credential ref (a POINTER string), never the
    // token value — same write-only model the Slack/Sentry artifacts use.
    await this.secrets.put({ ref: tokenAliasRef, value: grant.credentialRef });
    return {
      deployRef: {
        provider: this.api.providerKind,
        appId: app.appId,
        previewUrlPattern: app.previewUrlPattern,
      },
      projectConfig: {
        deployProvider: this.api.providerKind,
        deployAppId: app.appId,
        deployAppName: app.name,
        previewUrlPattern: app.previewUrlPattern,
        // The seam P-APP-ENV-2 fills: the runtime env attachment for this app is
        // attached separately (Plane B) and referenced here once it lands.
        envAttachmentRef: null,
      },
      secretRefs: { deployToken: tokenAliasRef },
    };
  }
}
