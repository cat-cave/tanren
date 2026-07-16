// The `direct_api` DeployAdapter — wraps the existing Vercel/Fly DeployProvisioners
// behind the DeployAdapter port (engine/contracts/deployAdapter.ts) WITHOUT
// rewriting them. provisionOrBind / deploy / status DELEGATE straight to the
// provisioner the deployRef provider selects (`deployProvisionerFor`); `verify` is
// the new capability built ON TOP: poll the provider's deployment status until a
// READY terminal (or fail LOUD on a failure terminal / a proven stuck-deploy), then
// SMOKE-CHECK the resolved URL is HTTP-reachable. This is what makes deploy-on-merge
// PROVEN instead of fire-and-forget.
//
// The provider provisioner is constructed per-call from the deployRef provider via
// the SHARED `deployProvisionerFor` selector, so the adapter never duplicates the
// Vercel/Fly wiring. The deploy token never reaches this file — it is resolved
// inside the provisioner (from the org grant's `credentialRef`) and flows only into
// the provider bearer.

import type {
  ApplyPreviewInput,
  ArtifactIdentity,
  BuildArtifactResult,
  DemoSurface,
  DeployAdapter,
  DeployRef,
  DeployStatus,
  DeployVerification,
  PreviewRelease,
  PromoteInput,
  ProvisionOrBindInput,
  ReleaseTransition,
  RollbackInput,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../contracts/deployAdapter.js";
import { parseDigest, parseProviderChecksum } from "../contracts/cas.js";
import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "../contracts/integrationProvisioner.js";
import type { DeployProvisionerDeps, DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import { deployProvisionerFor } from "../workflow/deployProvisionerFor.js";
import { pollUntilTerminal } from "./pollUntilTerminal.js";

/** The adapter-class kind this impl registers under. */
export const DIRECT_API_ADAPTER_KIND = "direct_api";

/** Wiring the `direct_api` adapter runs over: the provisioner deps + the verify seams. */
export interface DirectApiDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) every wrapped provisioner runs over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs against the resolved URL (scripted in tests). */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll CADENCE (the spacing between polls; no count — poll-until-terminal). */
  poll: VerifyPollPolicy;
}

/**
 * The `direct_api` DeployAdapter. Each method constructs the provider provisioner for
 * the deployRef provider kind and delegates; `verify` additionally polls to READY +
 * smoke-checks the URL.
 */
export class DirectApiDeployAdapter implements DeployAdapter {
  readonly kind = DIRECT_API_ADAPTER_KIND;

  constructor(private readonly deps: DirectApiDeployAdapterDeps) {}

  async provisionOrBind(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact> {
    const provisioner = deployProvisionerFor(grant.providerKind, this.deps.provisioner);
    return input.mode === "bind"
      ? provisioner.bind(grant, input.existingResourceId, projectCtx)
      : provisioner.provision(grant, projectCtx);
  }

  async deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult> {
    return deployProvisionerFor(ref.provider, this.deps.provisioner).deploy(grant, ref.appId, source);
  }

  async buildArtifact(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<BuildArtifactResult> {
    const built = await deployProvisionerFor(ref.provider, this.deps.provisioner).buildArtifact(
      grant,
      ref.appId,
      source,
    );
    return {
      artifactDigest: parseDigest(built.identity.artifactDigest),
      providerChecksum:
        built.identity.providerChecksum === null ? null : parseProviderChecksum(built.identity.providerChecksum),
      deploymentId: built.result.deploymentId,
      state: "built",
    };
  }

  async resolveArtifactDigest(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<ArtifactIdentity> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const raw = await provisioner.resolveArtifactIdentity(grant, ref.appId, deploymentId);
    return {
      artifactDigest: parseDigest(raw.artifactDigest),
      providerChecksum: raw.providerChecksum === null ? null : parseProviderChecksum(raw.providerChecksum),
    };
  }

  async applyPreview(grant: OrgGrant, ref: DeployRef, input: ApplyPreviewInput): Promise<PreviewRelease> {
    const deployed = await this.deploy(grant, ref, input.source);
    this.assertResolvedUrl(ref, deployed.deploymentId, deployed.url, "apply preview");
    return {
      deploymentId: deployed.deploymentId,
      url: deployed.url,
      environment: "preview",
      artifactDigest: input.artifactDigest,
      state: "preview",
    };
  }

  async promote(grant: OrgGrant, ref: DeployRef, input: PromoteInput): Promise<ReleaseTransition> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const promoted = await provisioner.promoteToProduction(grant, ref.appId, input.deploymentId);
    this.assertResolvedUrl(ref, promoted.deploymentId, promoted.url, "promote");
    return {
      deploymentId: promoted.deploymentId,
      url: promoted.url,
      environment: "production",
      artifactDigest: input.artifactDigest,
      state: "live",
    };
  }

  async rollback(grant: OrgGrant, ref: DeployRef, input: RollbackInput): Promise<ReleaseTransition> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const restored = await provisioner.rollbackToDeployment(grant, ref.appId, input.targetReleaseInstanceId);
    this.assertResolvedUrl(ref, restored.deploymentId, restored.url, "rollback");
    return {
      deploymentId: restored.deploymentId,
      url: restored.url,
      environment: "production",
      artifactDigest: input.targetArtifactDigest,
      state: "rolled_back",
    };
  }

  async teardownPreview(grant: OrgGrant, ref: DeployRef, previewId: string): Promise<void> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    await provisioner.teardownDeployment(grant, ref.appId, previewId);
  }

  async status(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const read = await provisioner.deploymentStatus(grant, ref.appId, deploymentId);
    return { state: read.state, ready: read.terminalReady, failed: read.terminalFailed, url: read.url };
  }

  /**
   * Resolve the demo EXERCISE SURFACE for a `direct_api` deploy: the resolved live
   * `web_url`, read from the deployment's provider status (the SAME concrete URL
   * `verify` smoke-checked). A deployment the provider reports with no URL throws
   * LOUD — there is no surface for the demo engine to exercise, and that is never a
   * silent skip. Read-only: this never triggers/mutates a deployment.
   */
  async demoSurface(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const read = await provisioner.deploymentStatus(grant, ref.appId, deploymentId, "resolve_demo_surface");
    if (read.url === "") {
      throw new Error(
        `demoSurface: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' has no resolved URL — no web surface to exercise`,
      );
    }
    return { kind: "web_url", url: read.url };
  }

  /**
   * Poll the provider until the deployment is READY (then smoke-check its URL), or
   * throw LOUD: a FAILURE terminal throws immediately; a PROVEN stuck (non-advancing)
   * state escalates LOUD via intelligent non-convergence (never "failed after N polls");
   * a smoke check that does not answer 2xx/3xx throws. The poll is UNBOUNDED while the
   * provider state advances (BUILDING → QUEUED → …) — a slow-but-progressing deploy is
   * never declared failed on a count. The success result is the PROOF the deploy is live.
   */
  async verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const readStatus = await provisioner.deploymentStatusReader(grant, ref.appId, deploymentId);
    const { poll, pollCount } = await pollUntilTerminal({
      readState: async () => {
        const read = await readStatus();
        return { state: read.state, ready: read.terminalReady, failed: read.terminalFailed, url: read.url };
      },
      onFailureTerminal: (state) =>
        new Error(
          `deploy verify: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' reached a FAILURE state '${state}'`,
        ),
      onStuck: (stuckState, polls) =>
        new Error(
          `deploy verify: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' is STUCK in non-terminal ` +
            `state '${stuckState}' with no advancement after ${String(polls)} polls`,
        ),
      intervalMs: this.deps.poll.intervalMs,
    });
    return this.smokeCheck(ref, deploymentId, poll.state, poll.url, pollCount);
  }

  /**
   * Smoke-check the resolved URL is HTTP-reachable (2xx/3xx). A non-success status —
   * a deployment reported READY but whose URL does not actually serve — throws LOUD;
   * an empty URL (the provider returned no host) is a hard error too.
   *
   * DEPLOYMENT-PROTECTION EXCEPTION: a `401`/`403` is NOT an unhealthy deploy — Vercel
   * Deployment Protection (and Fly equivalents) front a HEALTHY, RUNNING deployment with
   * an auth gate, so the server answering 401/403 PROVES it is up and serving. We treat
   * those as reachable (the provider returned the deployment is live; the gate is in
   * front). To smoke-check the BEHAVIOR behind the gate, disable deployment protection
   * on the deploy target (see the apex operator guide). Any OTHER non-2xx/3xx is a hard
   * fail (a READY deployment whose URL does not actually serve).
   */
  private async smokeCheck(
    ref: DeployRef,
    deploymentId: string,
    state: string,
    url: string,
    pollCount: number,
  ): Promise<DeployVerification> {
    if (url === "") {
      throw new Error(
        `deploy verify: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' is READY but the provider returned no URL to smoke-check`,
      );
    }
    const smokeStatus = await this.deps.urlProbe.probe(url);
    const reachable = (smokeStatus >= 200 && smokeStatus < 400) || smokeStatus === 401 || smokeStatus === 403;
    if (!reachable) {
      throw new Error(
        `deploy verify: deployment '${deploymentId}' URL '${url}' is not reachable (smoke check returned HTTP ${String(smokeStatus)})`,
      );
    }
    return { ready: true, state, url, pollCount, smokeStatus };
  }

  private assertResolvedUrl(ref: DeployRef, deploymentId: string, url: string, operation: string): void {
    if (url === "") {
      throw new Error(
        `deploy ${operation}: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' returned no resolved URL`,
      );
    }
  }
}
