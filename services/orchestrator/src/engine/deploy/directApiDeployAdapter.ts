// The `direct_api` DeployAdapter — wraps the existing Vercel/Fly DeployProvisioners
// behind the DeployAdapter port (engine/contracts/deployAdapter.ts) WITHOUT
// rewriting them. provisionOrBind / deploy / status DELEGATE straight to the
// provisioner the deployRef provider selects (`deployProvisionerFor`); `verify` is
// the new capability built ON TOP: poll the provider's deployment status until a
// READY terminal (or fail LOUD on a failure terminal / never-ready budget), then
// SMOKE-CHECK the resolved URL is HTTP-reachable. This is what makes deploy-on-merge
// PROVEN instead of fire-and-forget.
//
// The provider provisioner is constructed per-call from the deployRef provider via
// the SHARED `deployProvisionerFor` selector, so the adapter never duplicates the
// Vercel/Fly wiring. The deploy token never reaches this file — it is resolved
// inside the provisioner (from the org grant's `credentialRef`) and flows only into
// the provider bearer.

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
import type { DeployProvisionerDeps, DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import { deployProvisionerFor } from "../workflow/deployProvisionerFor.js";

/** The adapter-class kind this impl registers under. */
export const DIRECT_API_ADAPTER_KIND = "direct_api";

/** Wiring the `direct_api` adapter runs over: the provisioner deps + the verify seams. */
export interface DirectApiDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) every wrapped provisioner runs over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs against the resolved URL (scripted in tests). */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll cadence + bound (the never-ready guard; sleep injected for tests). */
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
    const read = await provisioner.deploymentStatus(grant, ref.appId, deploymentId);
    if (read.url === "") {
      throw new Error(
        `demoSurface: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' has no resolved URL — no web surface to exercise`,
      );
    }
    return { kind: "web_url", url: read.url };
  }

  /**
   * Poll the provider until the deployment is READY (then smoke-check its URL), or
   * throw LOUD: a FAILURE terminal throws immediately; exhausting the poll budget
   * without a ready terminal throws (never-ready guard); a smoke check that does not
   * answer 2xx/3xx throws. The success result is the PROOF the deploy is live.
   */
  async verify(grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    const provisioner = deployProvisionerFor(ref.provider, this.deps.provisioner);
    const { maxPolls, intervalMs, sleep } = this.deps.poll;
    let pollCount = 0;
    let lastState = "";
    let url = "";
    while (pollCount < maxPolls) {
      pollCount += 1;
      const read = await provisioner.deploymentStatus(grant, ref.appId, deploymentId);
      lastState = read.state;
      url = read.url;
      if (read.terminalFailed) {
        throw new Error(
          `deploy verify: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' reached a FAILURE state '${read.state}'`,
        );
      }
      if (read.terminalReady) {
        return this.smokeCheck(ref, deploymentId, read.state, url, pollCount);
      }
      if (pollCount < maxPolls) {
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `deploy verify: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' never became READY ` +
        `after ${String(maxPolls)} polls (last state '${lastState}')`,
    );
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
}
