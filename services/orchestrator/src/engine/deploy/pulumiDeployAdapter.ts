// The `pulumi` DeployAdapter — drives an Infrastructure-as-Code deployment via the
// Pulumi Automation surface (a stack `up` / `refresh`), reading the deployed endpoint
// back as a stack OUTPUT. Where `direct_api` wraps the Vercel/Fly REST providers,
// this class wraps a Pulumi STACK: provisionOrBind ensures the stack exists (select
// or init); `deploy` runs `pulumi up` against the merged source; `verify` polls the
// stack's update status to a SUCCEEDED terminal and then smoke-checks the resolved
// endpoint URL; `status` reads the latest update; `demoSurface` resolves the deployed
// `web_url` from the stack output.
//
// The Pulumi commands are driven over an INJECTABLE `PulumiStackRunner` seam (a real
// CLI/Automation-API runner over the substrate in production; scripted in tests) so
// the conformance suite proves the lifecycle with NO real cloud / Pulumi process. The
// Pulumi access token never reaches this file — it is resolved from the org grant's
// `credentialRef` and flows only into the runner's environment as a bearer.
//
// LOUD-FAIL ON MISSING CONFIG: a Pulumi deploy REQUIRES a backend the stack lives in
// (the grant's `pulumiBackend` — e.g. `https://api.pulumi.com` for the managed
// service, or an `s3://`/`file://` self-managed backend) AND the project the stack
// belongs to (the grant's `pulumiProject`). When either is absent we throw a typed
// {@link DeployAdapterConfigError} — the operator must declare which backend/project,
// a decision that cannot be inferred from the contract. This is the correct
// unconfigured behavior, NOT a stub.

import type {
  DemoSurface,
  DeployAdapter,
  DeployRef,
  DeployStatus,
  DeployVerification,
  ProvisionOrBindInput,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../contracts/deployAdapter.js";
import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "../contracts/integrationProvisioner.js";
import type { DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { DeployAdapterConfigError, DeployAdapterOperationError } from "./deployAdapterErrors.js";

/** The adapter-class kind this impl registers under. */
export const PULUMI_ADAPTER_KIND = "pulumi";

/**
 * The provider kind the pulumi adapter stamps onto the deployRef (so a deployRef that
 * came from this adapter is self-describing, mirroring `deploy.vercel`/`deploy.flyio`).
 */
export const PULUMI_PROVIDER_KIND = "deploy.pulumi";

/** The standard stack output key the adapter reads the deployed endpoint URL from. */
export const PULUMI_ENDPOINT_OUTPUT_KEY = "url";

/** The non-secret outcome of a `pulumi up`: the update id + the resolved endpoint. */
export interface PulumiUpdateResult {
  /** The Pulumi update id (the stable handle the verify poll reads status against). */
  updateId: string;
  /** The stack's resolved endpoint URL output (the deployed product's `url` output). */
  endpointUrl: string;
}

/** The provider-collapsed status of a Pulumi update (the verify poll primitive). */
export interface PulumiUpdateStatus {
  /** The Pulumi-reported update result (e.g. "in-progress" | "succeeded" | "failed"). */
  result: string;
  /** The update reached a SUCCEEDED terminal (the stack is up). */
  succeeded: boolean;
  /** The update reached a FAILED terminal (the `up` errored / was canceled). */
  failed: boolean;
  /** The stack's resolved endpoint URL output (empty until the stack publishes it). */
  endpointUrl: string;
}

/**
 * The injectable Pulumi driver the adapter runs over: the real impl shells the
 * `pulumi` CLI (or drives the Automation API) over the substrate; tests script it.
 * The base + project + stack identity is resolved by the adapter and passed in; the
 * access token flows in here (never logged) so the runner can authenticate.
 */
export interface PulumiStackRunner {
  /**
   * Ensure the stack exists under `project` on `backend` (select-or-init). Idempotent:
   * re-running onboarding must NOT error on an existing stack — it selects it.
   * Returns the stable stack id (`<project>/<stack>` qualified name).
   */
  ensureStack(input: { backend: string; project: string; stack: string; token: string }): Promise<{ stackId: string }>;
  /**
   * Run `pulumi up` for the stack against the merged `source` ref — deploy the IaC
   * program. Returns the update id + the resolved endpoint output. A failed update
   * throws (the adapter maps it to a loud {@link DeployAdapterOperationError}).
   */
  up(input: {
    backend: string;
    project: string;
    stack: string;
    token: string;
    source: DeploySource;
  }): Promise<PulumiUpdateResult>;
  /**
   * Read the current status of update `updateId` on the stack (the verify poll): the
   * Pulumi update result collapsed into succeeded/failed + the endpoint output.
   */
  updateStatus(input: {
    backend: string;
    project: string;
    stack: string;
    token: string;
    updateId: string;
  }): Promise<PulumiUpdateStatus>;
}

/** Wiring the `pulumi` adapter runs over: the runner + secrets + the verify seams. */
export interface PulumiDeployAdapterDeps {
  /** The Pulumi stack driver (CLI/Automation-API over the substrate; scripted in tests). */
  runner: PulumiStackRunner;
  /** The SecretStore the grant's Pulumi access token is resolved from. */
  secrets: SecretStore;
  /** The URL smoke-check probe verify runs against the resolved endpoint. */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll cadence + bound (the never-ready guard; sleep injected for tests). */
  poll: VerifyPollPolicy;
}

/** Read a required non-empty string field off the grant metadata, or throw LOUD. */
function requiredGrantField(grant: OrgGrant, key: string, hint: string): string {
  const value = grant.metadata[key];
  if (typeof value !== "string" || value === "") {
    throw new DeployAdapterConfigError(PULUMI_ADAPTER_KIND, key, hint);
  }
  return value;
}

/**
 * The `pulumi` DeployAdapter. `provisionOrBind` select-or-inits the stack; `deploy`
 * runs `pulumi up`; `verify` polls the update to SUCCEEDED + smoke-checks the endpoint;
 * `demoSurface` resolves the deployed `web_url`. The deployRef `appId` carries the
 * stack name (the stable per-project handle).
 */
export class PulumiDeployAdapter implements DeployAdapter {
  readonly kind = PULUMI_ADAPTER_KIND;

  constructor(private readonly deps: PulumiDeployAdapterDeps) {}

  private backend(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "pulumiBackend",
      "set the Pulumi backend the stack lives in (e.g. 'https://api.pulumi.com', or an 's3://'/'file://' self-managed backend) on the org grant metadata",
    );
  }

  private project(grant: OrgGrant): string {
    return requiredGrantField(
      grant,
      "pulumiProject",
      "set the Pulumi project the stack belongs to on the org grant metadata",
    );
  }

  private async token(grant: OrgGrant): Promise<string> {
    const secret = await this.deps.secrets.get(grant.credentialRef);
    if (secret === undefined) {
      throw new DeployAdapterConfigError(
        PULUMI_ADAPTER_KIND,
        "credentialRef",
        `the org grant credentialRef '${grant.credentialRef}' is not present in the secret store (the Pulumi access token)`,
      );
    }
    return secret.value;
  }

  /** The stack name for a project: its stable, sanitized name (the find-or-bind key). */
  private stackName(projectCtx: ProjectContext): string {
    const base = projectCtx.name ?? projectCtx.projectId;
    const slug = base
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "");
    return slug === "" ? `tanren-${projectCtx.projectId}` : slug;
  }

  async provisionOrBind(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact> {
    const backend = this.backend(grant);
    const project = this.project(grant);
    const token = await this.token(grant);
    // bind links an already-discovered stack by its name; provision select-or-inits
    // the project-named one. Both go through `ensureStack` (idempotent select-or-init).
    const stack = input.mode === "bind" ? input.existingResourceId : this.stackName(projectCtx);
    const { stackId } = await this.deps.runner.ensureStack({ backend, project, stack, token });
    return {
      deployRef: { provider: PULUMI_PROVIDER_KIND, appId: stack },
      projectConfig: {
        deployProvider: PULUMI_PROVIDER_KIND,
        deployAppId: stack,
        pulumiBackend: backend,
        pulumiProject: project,
        pulumiStackId: stackId,
      },
    };
  }

  async deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult> {
    const backend = this.backend(grant);
    const project = this.project(grant);
    const token = await this.token(grant);
    const result = await this.deps.runner.up({ backend, project, stack: ref.appId, token, source });
    // The `up` returns the update id + endpoint; the deploymentId is the update id
    // (the handle verify/status poll against). State is "in-progress" at trigger time.
    return { deploymentId: result.updateId, url: result.endpointUrl, state: "in-progress" };
  }

  async status(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const read = await this.read(grant, ref, deploymentId);
    return { state: read.result, ready: read.succeeded, failed: read.failed, url: read.endpointUrl };
  }

  async demoSurface(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const read = await this.read(grant, ref, deploymentId);
    if (read.endpointUrl === "") {
      throw new DeployAdapterOperationError(
        PULUMI_ADAPTER_KIND,
        `stack '${ref.appId}' update '${deploymentId}' published no '${PULUMI_ENDPOINT_OUTPUT_KEY}' output — no web surface to exercise`,
      );
    }
    return { kind: "web_url", url: read.endpointUrl };
  }

  async verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    const { maxPolls, intervalMs, sleep } = this.deps.poll;
    let pollCount = 0;
    let lastResult = "";
    let endpointUrl = "";
    while (pollCount < maxPolls) {
      pollCount += 1;
      const read = await this.read(grant, ref, deploymentId);
      lastResult = read.result;
      endpointUrl = read.endpointUrl;
      if (read.failed) {
        throw new DeployAdapterOperationError(
          PULUMI_ADAPTER_KIND,
          `stack '${ref.appId}' update '${deploymentId}' reached a FAILURE result '${read.result}'`,
        );
      }
      if (read.succeeded) {
        return this.smokeCheck(ref, deploymentId, read.result, endpointUrl, pollCount);
      }
      if (pollCount < maxPolls) {
        await sleep(intervalMs);
      }
    }
    throw new DeployAdapterOperationError(
      PULUMI_ADAPTER_KIND,
      `stack '${ref.appId}' update '${deploymentId}' never SUCCEEDED after ${String(maxPolls)} polls (last result '${lastResult}')`,
    );
  }

  private async read(grant: OrgGrant, ref: DeployRef, updateId: string): Promise<PulumiUpdateStatus> {
    const backend = this.backend(grant);
    const project = this.project(grant);
    const token = await this.token(grant);
    return this.deps.runner.updateStatus({ backend, project, stack: ref.appId, token, updateId });
  }

  private async smokeCheck(
    ref: DeployRef,
    deploymentId: string,
    state: string,
    url: string,
    pollCount: number,
  ): Promise<DeployVerification> {
    if (url === "") {
      throw new DeployAdapterOperationError(
        PULUMI_ADAPTER_KIND,
        `stack '${ref.appId}' update '${deploymentId}' SUCCEEDED but published no endpoint '${PULUMI_ENDPOINT_OUTPUT_KEY}' output to smoke-check`,
      );
    }
    const smokeStatus = await this.deps.urlProbe.probe(url);
    const reachable = (smokeStatus >= 200 && smokeStatus < 400) || smokeStatus === 401 || smokeStatus === 403;
    if (!reachable) {
      throw new DeployAdapterOperationError(
        PULUMI_ADAPTER_KIND,
        `stack '${ref.appId}' endpoint '${url}' is not reachable (smoke check returned HTTP ${String(smokeStatus)})`,
      );
    }
    return { ready: true, state, url, pollCount, smokeStatus };
  }
}
