// Provider-effect seam for group delivery. Durable state and authority resolution
// deliberately live outside this module: callers hand it an already-validated grant.

import { parseDigest } from "../../contracts/cas.js";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../contracts/integrationAuthority.js";
import type {
  DeployAdapter,
  DeployRef,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../../contracts/deployAdapter.js";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import { pollUntilTerminal } from "../../deploy/pollUntilTerminal.js";
import type { DeploySource } from "../../provisioners/deployProvisioner.js";
import type {
  GroupArtifact,
  GroupDeliveryPlan,
  GroupPreview,
  PriorGoodRelease,
  ResolvedGroupDeployTarget,
} from "./groupDeliveryCore.js";
import { isHealthySmokeStatus } from "./groupDeliveryDeployerHelpers.js";

export interface GroupDeliveryProviderEffectsDeps {
  readonly adapterFor: (plan: GroupDeliveryPlan) => DeployAdapter;
  readonly urlProbe: UrlReachabilityProbe;
  readonly verifyPoll?: VerifyPollPolicy;
  readonly grantFor: (
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    operation: IntegrationPrivilegedOperation,
    operationTarget: IntegrationOperationTarget,
  ) => Promise<OrgGrant>;
}

export class GroupDeliveryProviderEffects {
  constructor(private readonly deps: GroupDeliveryProviderEffectsDeps) {}

  async buildArtifact(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    grant: OrgGrant,
  ): Promise<GroupArtifact> {
    const built = await this.adapter(plan).buildArtifact(
      {
        deploy: grant,
        resolveArtifactIdentity: (deploymentId) =>
          this.deps.grantFor(plan, target, "resolve_artifact_identity", { resourceId: target.appId, deploymentId }),
      },
      ref(target),
      source(plan, target),
    );
    return { artifactDigest: built.artifactDigest, deploymentId: built.deploymentId };
  }

  async applyPreview(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    artifact: GroupArtifact,
    behaviorRevisionIds: readonly BehaviorRevisionId[],
    grant: OrgGrant,
  ): Promise<{ deploymentId: string }> {
    return this.adapter(plan).applyPreview(grant, ref(target), {
      source: source(plan, target),
      artifactDigest: parseDigest(artifact.artifactDigest),
      integrationNodeId: plan.tailRunId,
      behaviorRevisionIds,
    });
  }

  async teardownPreview(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    deploymentId: string,
    grant: OrgGrant,
  ): Promise<void> {
    await this.adapter(plan).teardownPreview(grant, ref(target), deploymentId);
  }

  async promote(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    artifact: GroupArtifact,
    preview: GroupPreview,
    previousReleaseInstanceId: string | null,
    grant: OrgGrant,
  ): Promise<{ deploymentId: string }> {
    return this.adapter(plan).promote(grant, ref(target), {
      deploymentId: preview.previewDeploymentId,
      artifactDigest: parseDigest(artifact.artifactDigest),
      previousReleaseInstanceId,
    });
  }

  async rollback(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    priorGood: PriorGoodRelease,
    grant: OrgGrant,
  ): Promise<void> {
    await this.adapter(plan).rollback(grant, ref(target), {
      targetArtifactDigest: parseDigest(priorGood.artifactDigest),
      targetReleaseInstanceId: priorGood.releaseInstanceId,
    });
  }

  async verifyReadiness(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    deploymentId: string,
    heartbeat?: () => Promise<void>,
  ): Promise<{ state: string; url: string; smokeStatus: number }> {
    const deployRef = ref(target);
    const { poll } = await pollUntilTerminal<{ state: string; ready: boolean; failed: boolean; url: string }>({
      readState: async () => {
        if (heartbeat !== undefined) await heartbeat();
        const grant = await this.deps.grantFor(plan, target, "deploy", { resourceId: target.appId, deploymentId });
        const status = await this.adapter(plan).status(grant, deployRef, deploymentId);
        return { state: status.state, ready: status.ready, failed: status.failed, url: status.url };
      },
      onFailureTerminal: (state) =>
        new Error(
          `land-group delivery: deployment '${deploymentId}' on '${deployRef.provider}/${deployRef.appId}' reached FAILURE state '${state}'`,
        ),
      onStuck: (state, polls) =>
        new Error(`land-group delivery: deployment '${deploymentId}' STUCK in '${state}' after ${String(polls)} polls`),
      intervalMs: this.deps.verifyPoll?.intervalMs ?? 5000,
    });
    if (poll.url === "")
      throw new Error(
        `land-group delivery: deployment '${deploymentId}' READY but the provider returned no URL to smoke-check`,
      );
    const smokeStatus = await this.deps.urlProbe.probe(poll.url);
    if (!isHealthySmokeStatus(smokeStatus)) {
      throw new Error(
        `land-group delivery: deployment '${deploymentId}' URL '${poll.url}' not reachable (HTTP ${String(smokeStatus)})`,
      );
    }
    return { state: poll.state, url: poll.url, smokeStatus };
  }

  private adapter(plan: GroupDeliveryPlan): DeployAdapter {
    return this.deps.adapterFor(plan);
  }
}

function ref(target: ResolvedGroupDeployTarget): DeployRef {
  return { provider: target.provider, appId: target.appId };
}

function source(plan: GroupDeliveryPlan, target: ResolvedGroupDeployTarget): DeploySource {
  return { repo: target.repoSlug, ref: plan.mainSha };
}
