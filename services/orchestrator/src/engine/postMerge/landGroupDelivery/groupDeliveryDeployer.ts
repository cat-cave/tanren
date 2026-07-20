// mq-13 PRODUCTION group-delivery deployer — the honest wrapper that drives the REAL
// DeployAdapter SP-6 lifecycle (buildArtifact / applyPreview / promote / rollback /
// teardownPreview), the REAL ProofBackedWebDemo, and the durable release-instance store for
// ONE completed land group. It implements the injected `GroupDeliveryDeployer` seam; the
// fail-closed decision tree lives in `groupDeliveryCore.ts` (unit-tested with a fake). It
// invents no adapter (buildDeployAdapter) and never bypasses MergeAuthority — it only
// activates an ALREADY-merged group's release.
//
// PREVIEW SAFETY: `DirectApiDeployAdapter.verify` marks the release LIVE in production, so it
// is NOT preview-safe. The preview step here verifies readiness via `adapter.status` polling +
// a URL smoke check (NO markLive), preserving the invariant that NOTHING promotes until the
// preview's proof-backed demo passes. Only the promote step verifies through the live path.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  buildDeployAdapter,
  DIRECT_API_ADAPTER_KIND,
  fetchUrlReachabilityProbe,
} from "../../deploy/buildDeployAdapter.js";
import { EventReapFailureReporter } from "../../deploy/reapFailureReporter.js";
import { parseDigest } from "../../contracts/cas.js";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import type {
  DeployAdapter,
  DeployRef,
  ReleaseInstanceRecord,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../../contracts/deployAdapter.js";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type { DeploySource } from "../../provisioners/deployProvisioner.js";
import type { EventStore } from "../../eventStore.js";
import type { ReleaseInstancesRepository } from "../../repositories/releaseInstances.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import { PgBehaviorRevisionResolver } from "../../repositories/behaviorRevisionResolver.js";
import { PgReleaseInstancesRepository } from "../../repositories/index.js";
import {
  buildProofBackedWebDemo,
  isProofBackedLoadFailure,
  type ProofBackedWebDemo,
} from "../../demo/proofBackedWebDemo.js";
import { runWithOrgScope } from "@tanren/db";
import { createLogger } from "../../observability/logger.js";
import { pollUntilTerminal } from "../../deploy/pollUntilTerminal.js";
import { loadSpecBehaviors } from "../demoOnDeployReads.js";
import { loadDeployOperationGrant, missingDeployGrantError } from "../deployOnMergeAuthority.js";
import type { SecretStore, DeployHttpTransport } from "../deployOnMergeDeployDeps.js";
import type {
  GroupArtifact,
  GroupDeliveryDeployer,
  GroupDeliveryPlan,
  GroupDemoOutcome,
  GroupPreview,
  GroupProduction,
  GroupReleaseHandle,
  PriorGoodRelease,
  ResolvedGroupDeployTarget,
} from "./groupDeliveryCore.js";

const log = createLogger("land-group-delivery-deployer");

export interface ProductionGroupDeliveryDeployerDeps {
  readonly pool: pg.Pool;
  readonly secrets: SecretStore;
  readonly transport: DeployHttpTransport;
  readonly eventStore: EventStore;
  readonly releaseInstances?: ReleaseInstancesRepository;
  readonly behaviorRevisions?: PgBehaviorRevisionResolver;
  readonly proofBackedWebDemo?: ProofBackedWebDemo;
  readonly urlProbe?: UrlReachabilityProbe;
  readonly verifyPoll?: VerifyPollPolicy;
}

/** The `deploy.<provider>` provider kind maps onto the `deployRef.provider`. */
export class ProductionGroupDeliveryDeployer implements GroupDeliveryDeployer {
  private readonly releaseInstances: ReleaseInstancesRepository;
  private readonly behaviorRevisions: PgBehaviorRevisionResolver;
  private readonly proofBackedWebDemo: ProofBackedWebDemo;
  private readonly urlProbe: UrlReachabilityProbe;

  constructor(private readonly deps: ProductionGroupDeliveryDeployerDeps) {
    this.releaseInstances = deps.releaseInstances ?? new PgReleaseInstancesRepository(deps.pool);
    this.behaviorRevisions = deps.behaviorRevisions ?? new PgBehaviorRevisionResolver(deps.pool);
    this.proofBackedWebDemo = deps.proofBackedWebDemo ?? buildProofBackedWebDemo(deps.pool, deps.eventStore);
    this.urlProbe = deps.urlProbe ?? fetchUrlReachabilityProbe();
  }

  async buildArtifact(input: { plan: GroupDeliveryPlan; target: ResolvedGroupDeployTarget }): Promise<GroupArtifact> {
    const { plan, target } = input;
    const ref = this.ref(target);
    const source = this.source(plan, target);
    const deployGrant = await this.grant(plan, target, "deploy", {
      resourceId: target.appId,
      sourceRepo: target.repoSlug,
      sourceRef: plan.mainSha,
    });
    const built = await this.adapter(plan).buildArtifact(
      {
        deploy: deployGrant,
        resolveArtifactIdentity: (deploymentId) =>
          this.grant(plan, target, "resolve_artifact_identity", { resourceId: target.appId, deploymentId }),
      },
      ref,
      source,
    );
    return { artifactDigest: built.artifactDigest, deploymentId: built.deploymentId };
  }

  async applyPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
  }): Promise<GroupPreview> {
    const { plan, target, artifact } = input;
    const ref = this.ref(target);
    const behaviorRevisionIds = await this.resolveBehaviorRevisionIds(plan);
    const grant = await this.grant(plan, target, "deploy", {
      resourceId: target.appId,
      sourceRepo: target.repoSlug,
      sourceRef: plan.mainSha,
    });
    const preview = await this.adapter(plan).applyPreview(grant, ref, {
      source: this.source(plan, target),
      artifactDigest: parseDigest(artifact.artifactDigest),
      integrationNodeId: plan.tailRunId,
      behaviorRevisionIds,
    });
    // Preview-safe readiness: poll status to READY + smoke-check the URL (NO markLive).
    await this.verifyReadiness(plan, target, preview.deploymentId);
    const release = await this.readBackRelease(plan, target, preview.deploymentId);
    return {
      release: {
        releaseInstanceId: release.releaseInstanceId,
        deploymentId: preview.deploymentId,
        artifactDigest: artifact.artifactDigest,
      },
      previewDeploymentId: preview.deploymentId,
    };
  }

  async demo(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    release: GroupReleaseHandle;
    environment: "preview" | "production";
  }): Promise<GroupDemoOutcome> {
    const { plan, target, release } = input;
    const record = await this.readBackRelease(plan, target, release.deploymentId);
    try {
      const result = await this.proofBackedWebDemo.demo(
        { runId: plan.tailRunId, specId: plan.tailSpecId, projectId: plan.projectId, orgId: plan.orgId },
        record,
      );
      if (result.failed === 0 && result.passed > 0) return { ok: true, reason: "" };
      return {
        ok: false,
        reason: `proof-backed demo failed (${String(result.failed)}/${String(result.passed + result.failed)} behaviors failed)`,
      };
    } catch (error) {
      const reason = isProofBackedLoadFailure(error)
        ? "proof-backed demo could not load the release behaviors"
        : "proof-backed demo could not observe the deployed behaviors";
      log.warn("group delivery demo failed", { landGroupId: plan.landGroupId, environment: input.environment, reason });
      return { ok: false, reason };
    }
  }

  async teardownPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    previewDeploymentId: string;
  }): Promise<void> {
    const { plan, target } = input;
    const grant = await this.grant(plan, target, "teardown_deployment", {
      resourceId: target.appId,
      deploymentId: input.previewDeploymentId,
    });
    await this.adapter(plan).teardownPreview(grant, this.ref(target), input.previewDeploymentId);
  }

  async promote(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
    preview: GroupPreview;
  }): Promise<GroupProduction> {
    const { plan, target, artifact, preview } = input;
    const ref = this.ref(target);
    const prior = await this.currentLiveRecord(plan, target);
    const grant = await this.grant(plan, target, "promote", {
      resourceId: target.appId,
      deploymentId: preview.previewDeploymentId,
    });
    const transition = await this.adapter(plan).promote(grant, ref, {
      deploymentId: preview.previewDeploymentId,
      artifactDigest: parseDigest(artifact.artifactDigest),
      previousReleaseInstanceId: prior?.releaseInstanceId ?? null,
    });
    // Production verify (the markLive path is correct here — the release IS production now).
    await this.verifyReadiness(plan, target, transition.deploymentId);
    const release = await this.readBackRelease(plan, target, transition.deploymentId);
    return {
      release: {
        releaseInstanceId: release.releaseInstanceId,
        deploymentId: transition.deploymentId,
        artifactDigest: artifact.artifactDigest,
      },
    };
  }

  async currentPriorGood(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    exceptReleaseInstanceId: string;
  }): Promise<PriorGoodRelease | undefined> {
    const record = await this.currentLiveRecord(input.plan, input.target, input.exceptReleaseInstanceId);
    if (record === undefined) return undefined;
    return { releaseInstanceId: record.releaseInstanceId, artifactDigest: record.artifactDigest };
  }

  async rollback(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    priorGood: PriorGoodRelease;
    brokenProduction: GroupProduction;
  }): Promise<void> {
    const { plan, target, priorGood } = input;
    const grant = await this.grant(plan, target, "rollback", {
      resourceId: target.appId,
      deploymentId: priorGood.releaseInstanceId,
    });
    // The REAL traffic rollback to the persisted prior-good lineage — throws LOUD if it does
    // not genuinely succeed (the caller degrades to needs_attention, never a pretended rollback).
    await this.adapter(plan).rollback(grant, this.ref(target), {
      targetArtifactDigest: parseDigest(priorGood.artifactDigest),
      targetReleaseInstanceId: priorGood.releaseInstanceId,
    });
  }

  // ---- private wiring -----------------------------------------------------------------

  private adapter(plan: GroupDeliveryPlan): DeployAdapter {
    return buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
      provisioner: { transport: this.deps.transport, secrets: this.deps.secrets },
      releaseInstances: this.releaseInstances,
      integrationNodeId: plan.tailRunId,
      urlProbe: this.urlProbe,
      ...(this.deps.verifyPoll !== undefined && { poll: this.deps.verifyPoll }),
      reapFailureReporter: new EventReapFailureReporter(this.deps.eventStore),
    });
  }

  private ref(target: ResolvedGroupDeployTarget): DeployRef {
    return { provider: target.provider, appId: target.appId };
  }

  private source(plan: GroupDeliveryPlan, target: ResolvedGroupDeployTarget): DeploySource {
    return { repo: target.repoSlug, ref: plan.mainSha };
  }

  private async grant(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    operation: "deploy" | "resolve_artifact_identity" | "promote" | "rollback" | "teardown_deployment",
    operationTarget: { resourceId?: string; deploymentId?: string; sourceRepo?: string; sourceRef?: string },
  ): Promise<OrgGrant> {
    const grant = await loadDeployOperationGrant(
      this.deps.pool,
      plan.projectId,
      { provider: target.provider, orgId: plan.orgId },
      operation,
      operationTarget,
    );
    if (grant === undefined) {
      throw missingDeployGrantError(plan.projectId, { provider: target.provider, orgId: plan.orgId }, operation);
    }
    return grant;
  }

  /** Poll the provider deployment status to READY (unbounded while advancing) + smoke-check the URL. */
  private async verifyReadiness(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    deploymentId: string,
  ): Promise<void> {
    const ref = this.ref(target);
    const adapter = this.adapter(plan);
    const { poll } = await pollUntilTerminal<{ state: string; ready: boolean; failed: boolean; url: string }>({
      readState: async () => {
        const grant = await this.grant(plan, target, "deploy", { resourceId: target.appId, deploymentId });
        const status = await adapter.status(grant, ref, deploymentId);
        return { state: status.state, ready: status.ready, failed: status.failed, url: status.url };
      },
      onFailureTerminal: (state) =>
        new Error(
          `land-group delivery: deployment '${deploymentId}' on '${ref.provider}/${ref.appId}' reached FAILURE state '${state}'`,
        ),
      onStuck: (state, polls) =>
        new Error(`land-group delivery: deployment '${deploymentId}' STUCK in '${state}' after ${String(polls)} polls`),
      intervalMs: this.deps.verifyPoll?.intervalMs ?? 5000,
    });
    if (poll.url === "") {
      throw new Error(
        `land-group delivery: deployment '${deploymentId}' READY but the provider returned no URL to smoke-check`,
      );
    }
    const smoke = await this.urlProbe.probe(poll.url);
    const reachable = (smoke >= 200 && smoke < 400) || smoke === 401 || smoke === 403;
    if (!reachable) {
      throw new Error(
        `land-group delivery: deployment '${deploymentId}' URL '${poll.url}' not reachable (HTTP ${String(smoke)})`,
      );
    }
  }

  private async readBackRelease(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    deploymentId: string,
  ): Promise<ReleaseInstanceRecord> {
    const record = await this.releaseInstances.getByDeployment({
      orgId: plan.orgId,
      provider: target.provider,
      appId: target.appId,
      deploymentId,
    });
    if (record === undefined) {
      throw new Error(
        `land-group delivery: no persisted release instance for deployment '${deploymentId}' on '${target.provider}/${target.appId}'`,
      );
    }
    return record;
  }

  private async currentLiveRecord(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    exceptReleaseInstanceId?: string,
  ): Promise<ReleaseInstanceRecord | undefined> {
    return runWithOrgScope(this.deps.pool, plan.orgId, (client) =>
      ReleaseInstancesStore.latestLive(
        client,
        plan.orgId,
        plan.projectId,
        target.provider,
        target.appId,
        exceptReleaseInstanceId,
      ),
    );
  }

  /** Resolve the group's active behavior REVISION ids — the union of the member specs' behaviors. */
  private async resolveBehaviorRevisionIds(plan: GroupDeliveryPlan): Promise<BehaviorRevisionId[]> {
    const behaviorIds = new Set<string>();
    await runWithSystemScope(this.deps.pool, async (client) => {
      for (const specId of plan.memberSpecIds) {
        const behaviors = await loadSpecBehaviors(client, specId, plan.orgId, plan.projectId);
        for (const behavior of behaviors) behaviorIds.add(behavior.behaviorId);
      }
    });
    if (behaviorIds.size === 0) return [];
    const resolved = await this.behaviorRevisions.resolveActive({
      orgId: plan.orgId,
      projectId: plan.projectId,
      behaviorIds: [...behaviorIds],
    });
    return resolved.map((entry) => entry.revisionId);
  }
}
