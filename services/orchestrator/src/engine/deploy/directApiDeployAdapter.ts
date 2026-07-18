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
  BuildArtifactAuthority,
  BuildArtifactResult,
  DemoSurface,
  DeployAdapter,
  DeployRef,
  DeployStatus,
  DeployVerification,
  DeployGrantForAttempt,
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
import type { ReleaseInstancesRepository } from "../repositories/releaseInstances.js";
import { reapHadFailure, type ReapOutcome } from "../provisioners/deployProvisioner.js";
import type { ReapFailureReporter } from "./reapFailureReporter.js";
import { createLogger } from "../observability/logger.js";

/** The adapter-class kind this impl registers under. */
export const DIRECT_API_ADAPTER_KIND = "direct_api";

const reapLog = createLogger("deploy-reap");

/** Wiring the `direct_api` adapter runs over: the provisioner deps + the verify seams. */
export interface DirectApiDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) every wrapped provisioner runs over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs against the resolved URL (scripted in tests). */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll CADENCE (the spacing between polls; no count — poll-until-terminal). */
  poll: VerifyPollPolicy;
  /** Durable release lifecycle store; required for every direct-api adapter. */
  releaseInstances: ReleaseInstancesRepository;
  /** The scalar integration-node lineage for a build that has no preview input yet. */
  integrationNodeId?: string;
  /**
   * OPTIONAL durable reporter for a non-converged post-verify machine reap. When the
   * Fly single-instance reap cannot fully converge (a list/delete blip), the deploy
   * STILL succeeds — but instead of silently swallowing the failure this reporter
   * emits a LOUD, durable `deploy.reap_failed` so machine-accumulation is attributable
   * to infra (the apex-v96 class), not blamed on product code. Omitted only for
   * pure-adapter unit tests that assert the verify contract without the event tail;
   * production wiring supplies it (see deployOnMergeReads.ts). Absent ⇒ a loud log only.
   */
  reapFailureReporter?: ReapFailureReporter;
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

  async buildArtifact(
    authority: BuildArtifactAuthority,
    ref: DeployRef,
    source: DeploySource,
  ): Promise<BuildArtifactResult> {
    const deployed = await this.deploy(authority.deploy, ref, source);
    const identity = await this.resolveArtifactDigest(
      await authority.resolveArtifactIdentity(deployed.deploymentId),
      ref,
      deployed.deploymentId,
    );
    await this.releaseInstances().create({
      orgId: authority.deploy.orgId,
      projectId: authority.deploy.projectId,
      provider: ref.provider,
      appId: ref.appId,
      environment: "preview",
      deploymentId: deployed.deploymentId,
      sourceRef: source.ref,
      artifactDigest: identity.artifactDigest,
      providerChecksum: identity.providerChecksum,
      integrationNodeId: this.integrationNodeId(authority.deploy),
      behaviorRevisionIds: [],
      url: deployed.url,
      state: "built",
    });
    return { ...identity, deploymentId: deployed.deploymentId, url: deployed.url, state: "built" };
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
    await this.releaseInstances().applyPreview({
      orgId: grant.orgId,
      projectId: grant.projectId,
      provider: ref.provider,
      appId: ref.appId,
      environment: "preview",
      deploymentId: deployed.deploymentId,
      sourceRef: input.source.ref,
      artifactDigest: input.artifactDigest,
      providerChecksum: null,
      integrationNodeId: input.integrationNodeId,
      behaviorRevisionIds: input.behaviorRevisionIds,
      url: deployed.url,
      state: "preview",
    });
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
    await this.releaseInstances().promote({
      orgId: grant.orgId,
      projectId: grant.projectId,
      provider: ref.provider,
      appId: ref.appId,
      deploymentId: input.deploymentId,
      promotedDeploymentId: promoted.deploymentId,
      artifactDigest: input.artifactDigest,
      previousReleaseInstanceId: input.previousReleaseInstanceId,
      url: promoted.url,
    });
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
    await this.releaseInstances().rollback({
      orgId: grant.orgId,
      projectId: grant.projectId,
      releaseInstanceId: input.targetReleaseInstanceId,
      targetArtifactDigest: input.targetArtifactDigest,
      deploymentId: restored.deploymentId,
      url: restored.url,
    });
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
    await this.releaseInstances().teardownPreview({
      orgId: grant.orgId,
      provider: ref.provider,
      appId: ref.appId,
      deploymentId: previewId,
    });
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
  async verify(
    grantForAttempt: DeployGrantForAttempt,
    ref: DeployRef,
    deploymentId: string,
  ): Promise<DeployVerification> {
    const releases = this.releaseInstances();
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    let verifiedGrant: OrgGrant | undefined;
    const { poll, pollCount } = await pollUntilTerminal({
      readState: async () => {
        verifiedGrant = await grantForAttempt();
        const read = await provisioner.deploymentStatus(verifiedGrant, ref.appId, deploymentId);
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
    const verification = await this.smokeCheck(ref, deploymentId, poll.state, poll.url, pollCount);
    if (verifiedGrant === undefined) throw new Error("deploy verify: provider never supplied an org grant");
    await releases.markLive({
      orgId: verifiedGrant.orgId,
      projectId: verifiedGrant.projectId,
      provider: ref.provider,
      appId: ref.appId,
      deploymentId,
      url: verification.url,
    });
    // Fly's single-instance convergence reaps old machines through this hook. It
    // deliberately runs only after the ready poll, smoke check, and durable live
    // transition above. Cleanup is best-effort: it must not turn a verified, marked
    // live release into a failed deployment when the provider's reap call flakes —
    // BUT a flake is NOT silently swallowed (that re-introduces the apex-v96
    // machine-accumulation → file-store-fragmentation class). A non-converged reap
    // is reported LOUD + durable (`deploy.reap_failed`), and the out-of-band
    // Fly-machine reconciler sweep retries next pass.
    const reapOutcome = await provisioner
      .afterVerifiedDeployment(verifiedGrant, ref.appId, deploymentId)
      .catch((error: unknown): ReapOutcome | undefined => {
        // A THROW from the reap hook (never expected — the reap is internally
        // best-effort) still must not fail the deploy, but it IS reported as a
        // list-level failure so the accumulation risk stays visible.
        reapLog.warn("post-verify reap hook threw (deploy unaffected)", {
          provider: ref.provider,
          appId: ref.appId,
          deploymentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          appName: ref.appId,
          keptMachineId: deploymentId,
          reapedMachineIds: [],
          listFailed: true,
          failedMachineIds: [],
        };
      });
    if (reapOutcome !== undefined && reapHadFailure(reapOutcome)) {
      await this.reportReapFailure(reapOutcome, verifiedGrant, ref.provider, ref.appId, deploymentId);
    }
    return verification;
  }

  /**
   * Emit the durable `deploy.reap_failed` for a non-converged reap (or loudly log
   * when no reporter is wired). NEVER throws — a reporting failure must not fail an
   * already-verified, marked-live deploy.
   */
  private async reportReapFailure(
    outcome: ReapOutcome,
    grant: OrgGrant,
    provider: string,
    appId: string,
    deploymentId: string,
  ): Promise<void> {
    const reporter = this.deps.reapFailureReporter;
    if (reporter === undefined) {
      reapLog.warn("post-verify machine reap did not converge (no durable reporter wired)", {
        provider,
        appId,
        deploymentId,
        listFailed: outcome.listFailed,
        failedMachineCount: outcome.failedMachineIds.length,
        reapedMachineCount: outcome.reapedMachineIds.length,
      });
      return;
    }
    await reporter
      .report(outcome, {
        orgId: grant.orgId,
        projectId: grant.projectId,
        provider,
        appId,
        deploymentId,
        source: "verify",
      })
      .catch((error: unknown) => {
        reapLog.error(
          "failed to emit deploy.reap_failed (deploy unaffected)",
          { provider, appId, deploymentId },
          error,
        );
      });
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

  private integrationNodeId(grant: OrgGrant): string {
    const metadataNode = grant.metadata["integrationNodeId"];
    if (typeof metadataNode === "string" && metadataNode !== "") return metadataNode;
    if (this.deps.integrationNodeId !== undefined && this.deps.integrationNodeId !== "") {
      return this.deps.integrationNodeId;
    }
    return `run:${grant.projectId}`;
  }

  private releaseInstances(): ReleaseInstancesRepository {
    return this.deps.releaseInstances;
  }
}
