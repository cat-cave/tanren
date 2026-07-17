// The shared shape of the deploy IntegrationProvisioners: Vercel + Fly.
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
// vars — that attachment is the runtime app-env wiring (Plane B), explicitly OUT of scope here.
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
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../contracts/integrationAuthority.js";
import type { DeployHttpTransport } from "./deployTransport.js";
import { deployAppName } from "./deployAppName.js";
import { secretValueForDeployOperation } from "./deployOperationAuthority.js";
import type {
  DeployArtifactIdentity,
  DeployEnvVar,
  DeployProvisionerDeps,
  DeployResult,
  DeploySource,
} from "./deployProvisionerTypes.js";

export { DEPLOY_APP_NAME_MAX_LEN, deployAppName } from "./deployAppName.js";
export type {
  DeployArtifactIdentity,
  DeployEnvVar,
  DeployProvisionerDeps,
  DeployResult,
  DeploySource,
} from "./deployProvisionerTypes.js";

/**
 * A provider-side deploy app/project: the stable handle (`appId`), the human
 * `name` used both as the brownfield label and as the find-or-create idempotency
 * key, and the `previewUrlPattern` the provider exposes for preview deploys.
 *
 * PREVIEW-URL CONVENTION (converged end-to-end): the pattern uses the SAME
 * `{branch}` / `{pr}` placeholders the dashboard's `derivePreviewUrl` substitutes —
 * NOT a `*` wildcard (which the dashboard cannot resolve). Vercel exposes a
 * deterministic per-branch URL (`…-git-{branch}-<scope>.vercel.app`); Fly serves a
 * single stable hostname (no placeholder). So a rendered preview URL always resolves.
 */
export interface DeployApp {
  appId: string;
  name: string;
  previewUrlPattern: string;
}

/**
 * The provider-reported live status of a TRIGGERED deployment, read back by polling
 * (the verify step). `state` is the provider's own string; `terminalReady` /
 * `terminalFailed` collapse the provider's vocabulary into the two outcomes verify
 * waits on (Vercel READY/ERROR/CANCELED, Fly started/stopped/failed). `url` is the
 * resolved live URL the deployment is reachable at (carried through so verify smoke-
 * checks it). NON-SECRET — a URL + a state string.
 */
export interface DeploymentStatus {
  /** The provider's raw state string (e.g. "BUILDING" | "READY" | "ERROR" | "started"). */
  state: string;
  /** The deployment finished and is live (the provider reported a ready/running terminal). */
  terminalReady: boolean;
  /** The deployment finished in FAILURE (the provider reported an error/canceled terminal). */
  terminalFailed: boolean;
  /** The resolved live URL the deployment is reachable at (concrete, no placeholder). */
  url: string;
}

/**
 * The provider-specific HTTP primitives. The base class drives find-or-create,
 * bind, discover, artifact assembly, and runtime env attachment on top of these;
 * a new deploy provider implements only this surface (Vercel / Fly do today).
 */
export interface DeployProviderApi {
  /** The provider kind this API speaks for (`deploy.vercel` | `deploy.flyio`). */
  readonly providerKind: string;
  /** List the org/team's existing deploy apps/projects (brownfield discover). */
  listApps(grant: OrgGrant, token: string): Promise<DeployApp[]>;
  /** Create one app/project under the team. Caller has already checked it is absent. */
  createApp(grant: OrgGrant, token: string, name: string, projectCtx: ProjectContext): Promise<DeployApp>;
  /**
   * Attach the runtime env VARS onto the deployed app: Vercel
   * `POST /v10/projects/{id}/env`, Fly the app-secrets endpoint. Each var's VALUE
   * is sent as the app's environment over the transport — and ONLY there. The
   * provider receives the values; this code never logs/returns them.
   */
  setEnvVars(grant: OrgGrant, token: string, appId: string, vars: ReadonlyArray<DeployEnvVar>): Promise<void>;
  /**
   * TRIGGER a build + release of `source` onto the created app: Vercel
   * `POST /v13/deployments` (gitSource = the merged repo + ref); Fly a Machines
   * release that runs the app's latest image. Returns the live deployment handle +
   * resolved URL + state. This is the step that makes a deploy ACTUALLY HAPPEN —
   * `createApp` alone yields an empty app. A failure throws LOUD (never a silent
   * no-op): a configured deploy that cannot release is a hard error.
   */
  triggerDeploy(grant: OrgGrant, token: string, app: DeployApp, source: DeploySource): Promise<DeployResult>;
  /**
   * Read the live status of a TRIGGERED deployment (the verify poll): Vercel
   * `GET /v13/deployments/{id}` (`readyState`), Fly `GET /v1/apps/{app}/machines/{id}`
   * (`state`). Returns the provider's state collapsed into the ready/failed terminals
   * verify waits on, plus the resolved URL. A provider read FAILURE throws LOUD — a
   * deployment whose status cannot be read is a hard error, never an assumed-ready.
   */
  getDeployment(grant: OrgGrant, token: string, app: DeployApp, deploymentId: string): Promise<DeploymentStatus>;
  /**
   * Perform provider-specific cleanup only after a deployment has passed the
   * adapter's health verification and its release row is durable. Providers with
   * no such cleanup omit this hook.
   */
  afterVerifiedDeployment?(grant: OrgGrant, token: string, app: DeployApp, deploymentId: string): Promise<void>;
  /** Read the immutable artifact identity attached to an existing deployment. */
  resolveArtifactIdentity(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    deploymentId: string,
  ): Promise<DeployArtifactIdentity>;
  /** Move production traffic to the selected preview/staged deployment. */
  promoteToProduction(grant: OrgGrant, token: string, app: DeployApp, deploymentId: string): Promise<DeployResult>;
  /** Move production traffic back to a previously verified deployment. */
  rollbackToDeployment(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    targetDeploymentId: string,
  ): Promise<DeployResult>;
  /** Remove a preview deployment. Idempotent when the deployment is already absent. */
  teardownDeployment(grant: OrgGrant, token: string, app: DeployApp, deploymentId: string): Promise<void>;
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

  get providerKind(): string {
    return this.api.providerKind;
  }

  /**
   * attach the runtime env VARS onto an already-deployed app (the
   * `appId` from the `deployRef`). Resolves the org grant's deploy token and hands
   * the vars to the provider's `setEnvVars`. The VALUES travel ONLY into that
   * request; this method returns nothing and logs/keeps nothing. An empty `vars`
   * list is a no-op (no provider call).
   */
  async attachRuntimeEnv(grant: OrgGrant, appId: string, vars: ReadonlyArray<DeployEnvVar>): Promise<void> {
    if (vars.length === 0) {
      return;
    }
    const token = await this.resolveToken(grant, "attach_runtime_env", {
      resourceId: appId,
      environment: "production",
    });
    await this.api.setEnvVars(grant, token, appId, vars);
  }

  /**
   * TRIGGER a real deploy of `source` onto the app identified by `appId`. Resolves
   * the org deploy token, finds the app under the grant (by its stable id), and
   * hands it to the provider's `triggerDeploy` (which builds + releases the merged
   * ref). Returns the live deployment handle + resolved URL. A missing app or a
   * provider failure throws LOUD — a configured deploy never silently no-ops.
   */
  async deploy(grant: OrgGrant, appId: string, source: DeploySource): Promise<DeployResult> {
    const token = await this.resolveToken(grant, "deploy", {
      resourceId: appId,
      sourceRepo: source.repo,
      sourceRef: source.ref,
    });
    const app = (await this.api.listApps(grant, token)).find((candidate) => candidate.appId === appId);
    if (app === undefined) {
      throw new Error(`${this.api.providerKind}: cannot deploy unknown app '${appId}' (not found under the org grant)`);
    }
    return this.api.triggerDeploy(grant, token, app, source);
  }

  /**
   * Read the live status of a previously-triggered deployment on `appId` (the verify
   * poll primitive). Resolves the org token, finds the app under the grant, and hands
   * it to the provider's {@link DeployProviderApi.getDeployment}. A missing app or a
   * provider read failure throws LOUD — never an assumed-ready degrade.
   */
  async deploymentStatus(
    grant: OrgGrant,
    appId: string,
    deploymentId: string,
    operation: "verify" | "resolve_demo_surface" = "verify",
  ): Promise<DeploymentStatus> {
    const token = await this.resolveToken(grant, operation, { resourceId: appId, deploymentId });
    const app = (await this.api.listApps(grant, token)).find((candidate) => candidate.appId === appId);
    if (app === undefined) {
      throw new Error(
        `${this.api.providerKind}: cannot read deployment status for unknown app '${appId}' (not found under the org grant)`,
      );
    }
    return this.api.getDeployment(grant, token, app, deploymentId);
  }

  /**
   * Run a provider's best-effort post-verification cleanup. The direct-api adapter
   * calls this only after the ready poll, URL smoke check, and `markLive` all
   * succeed, so cleanup can never remove the prior live surface for a failed
   * deployment. Providers without this hook intentionally do nothing.
   */
  async afterVerifiedDeployment(grant: OrgGrant, appId: string, deploymentId: string): Promise<void> {
    const cleanup = this.api.afterVerifiedDeployment;
    if (cleanup === undefined) {
      return;
    }
    const { token, app } = await this.appAccess(
      grant,
      appId,
      deploymentId,
      "verify",
      "clean up a verified deployment on",
    );
    await cleanup.call(this.api, grant, token, app, deploymentId);
  }

  /** Resolve an existing deployment's provider-reported artifact identity. */
  async resolveArtifactIdentity(grant: OrgGrant, appId: string, deploymentId: string): Promise<DeployArtifactIdentity> {
    const { token, app } = await this.appAccess(
      grant,
      appId,
      deploymentId,
      "resolve_artifact_identity",
      "resolve artifact identity for",
    );
    return this.api.resolveArtifactIdentity(grant, token, app, deploymentId);
  }

  /** Promote the selected deployment to the app's production traffic surface. */
  async promoteToProduction(grant: OrgGrant, appId: string, deploymentId: string): Promise<DeployResult> {
    const { token, app } = await this.appAccess(grant, appId, deploymentId, "promote", "promote a deployment on");
    return this.api.promoteToProduction(grant, token, app, deploymentId);
  }

  /** Restore a previously verified deployment to the production traffic surface. */
  async rollbackToDeployment(grant: OrgGrant, appId: string, targetDeploymentId: string): Promise<DeployResult> {
    const { token, app } = await this.appAccess(
      grant,
      appId,
      targetDeploymentId,
      "rollback",
      "roll back a deployment on",
    );
    return this.api.rollbackToDeployment(grant, token, app, targetDeploymentId);
  }

  /** Tear down a preview deployment; providers make an already-gone target a success. */
  async teardownDeployment(grant: OrgGrant, appId: string, deploymentId: string): Promise<void> {
    const { token, app } = await this.appAccess(
      grant,
      appId,
      deploymentId,
      "teardown_deployment",
      "tear down a deployment on",
    );
    await this.api.teardownDeployment(grant, token, app, deploymentId);
  }

  async discover(grant: OrgGrant, projectCtx: ProjectContext): Promise<ExistingResource[]> {
    const token = await this.resolveTokenForProject(grant, projectCtx, "discover", {});
    const apps = await this.api.listApps(grant, token);
    return apps.map((app) => ({
      id: app.appId,
      label: app.name,
      metadata: { previewUrlPattern: app.previewUrlPattern, provider: this.api.providerKind },
    }));
  }

  async provision(grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const token = await this.resolveTokenForProject(
      grant,
      projectCtx,
      "provision",
      projectIntegrationOperationTarget(projectCtx),
    );
    const name = deployAppName(projectCtx);
    // Find-or-create: re-running onboarding must NEVER create a second app. We
    // list first and reuse the stable-named match rather than blindly creating.
    const existing = (await this.api.listApps(grant, token)).find((app) => app.name === name);
    const app = existing ?? (await this.api.createApp(grant, token, name, projectCtx));
    return this.artifactFor(grant, app);
  }

  async bind(grant: OrgGrant, existingResourceId: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const token = await this.resolveTokenForProject(
      grant,
      projectCtx,
      "bind",
      projectIntegrationOperationTarget(projectCtx, existingResourceId),
    );
    const app = (await this.api.listApps(grant, token)).find((candidate) => candidate.appId === existingResourceId);
    if (app === undefined) {
      throw new Error(
        `${this.api.providerKind}: cannot bind unknown deploy app '${existingResourceId}' (not found under the org grant)`,
      );
    }
    return this.artifactFor(grant, app);
  }

  private async resolveToken(
    grant: OrgGrant,
    operation: IntegrationPrivilegedOperation,
    target: IntegrationOperationTarget,
  ): Promise<string> {
    return secretValueForDeployOperation(this.secrets, this.api.providerKind, grant, operation, target);
  }

  private resolveTokenForProject(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    operation: IntegrationPrivilegedOperation,
    target: IntegrationOperationTarget,
  ): Promise<string> {
    if (grant.orgId !== projectCtx.orgId || grant.projectId !== projectCtx.projectId) {
      throw new Error("eligible operation lease project binding mismatch");
    }
    return this.resolveToken(grant, operation, target);
  }

  private async appAccess(
    grant: OrgGrant,
    appId: string,
    deploymentId: string,
    authorityOperation: "verify" | "resolve_artifact_identity" | "promote" | "rollback" | "teardown_deployment",
    description: string,
  ): Promise<{ token: string; app: DeployApp }> {
    const token = await this.resolveToken(grant, authorityOperation, { resourceId: appId, deploymentId });
    const app = (await this.api.listApps(grant, token)).find((candidate) => candidate.appId === appId);
    if (app === undefined) {
      throw new Error(
        `${this.api.providerKind}: cannot ${description} unknown app '${appId}' (not found under the org grant)`,
      );
    }
    return { token, app };
  }

  /**
   * Assemble the uniform artifact for a created/bound app: the `deployRef` (+
   * preview-URL pattern), the non-secret projectConfig, and a per-app deploy-token
   * ALIAS ref (a pointer to the org credential, NOT the value). The alias makes the
   * runtime deploy adapter resolve the right scoped token without re-deriving the
   * org grant. `envAttachmentRef` is the clean seam attaches the app's
   * runtime env vars onto — left unpopulated here by design.
   */
  private async artifactFor(grant: OrgGrant, app: DeployApp): Promise<ProvisionedArtifact> {
    const tokenAliasRef = `secret://deploy/${this.api.providerKind}/${app.appId}/token`;
    // The alias points at the org credential ref (a POINTER string), never the
    // token value — same write-only model the Slack/Sentry artifacts use.
    await this.secrets.put({ ref: tokenAliasRef, value: grant.eligibleOperation.credentialRef });
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
        // `envAttachmentRef` is intentionally ABSENT here, not a null placeholder:
        // the runtime env attachment is a separate Plane-B step (`attachRuntimeAppEnv`)
        // that writes the ref once it lands. Absent = not yet attached.
      },
      secretRefs: { deployToken: tokenAliasRef },
    };
  }
}
