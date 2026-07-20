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

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
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
import { createLogger } from "../../observability/logger.js";
import { pollUntilTerminal } from "../../deploy/pollUntilTerminal.js";
import { loadSpecBehaviors } from "../demoOnDeployReads.js";
import { deployAuditEnvelope, loadDeployOperationGrant, missingDeployGrantError } from "../deployOnMergeAuthority.js";
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

/**
 * Build the GROUP's `deploy.verified` payload — the shape mq-15's `gatherEvidenceFromClient`
 * and ds-6's `designDeliveryProofReads` read (provider / appId / deploymentId / url / state +
 * smokeStatus + the audit envelope, bound to the LIVE production deployment). Pure so the shape
 * is unit-testable against BOTH the strict registered `DeployVerifiedPayload` and the consumers'
 * projections (Finding 2). NON-SECRET — refs + a URL + a state + a status code.
 */
export function groupDeployVerifiedPayload(
  plan: GroupDeliveryPlan,
  target: ResolvedGroupDeployTarget,
  verified: { deploymentId: string; url: string; state: string; smokeStatus: number },
) {
  return {
    provider: target.provider,
    appId: target.appId,
    deploymentId: verified.deploymentId,
    url: verified.url,
    state: verified.state,
    smokeStatus: verified.smokeStatus,
    ...deployAuditEnvelope({
      provider: target.provider,
      appId: target.appId,
      orgId: plan.orgId,
      policyVersion: target.policyVersion,
    }),
  };
}

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
  /** Injectable DeployAdapter (tests); defaults to the production `direct_api` adapter per drive. */
  readonly deployAdapter?: DeployAdapter;
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
    // NO verify here — the caller runs verifyPreview separately so a verify failure can tear
    // the preview down (Finding 4) instead of leaking it. The preview release is persisted.
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

  async verifyPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    preview: GroupPreview;
    heartbeat?: () => Promise<void>;
  }): Promise<void> {
    // Preview-safe readiness: poll status to READY + smoke-check the URL (NO markLive). Throws
    // LOUD when the preview never becomes reachable (the core tears it down → preview_failed).
    await this.verifyReadiness(input.plan, input.target, input.preview.previewDeploymentId, input.heartbeat);
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
    heartbeat?: () => Promise<void>;
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
    const verified = await this.verifyReadiness(plan, target, transition.deploymentId, input.heartbeat);
    // Finding 2: durably emit the GROUP's `deploy.verified` on the tail run so mq-15 seals +
    // ds-6 joins from the group's evidence (in-17's per-run delivery — the sole other emitter —
    // is membership-guarded off for group members, so this is the ONLY deploy.verified a land
    // group gets). The shape is exactly what mq-15/ds-6 read (provider/appId/deploymentId/url/
    // state + smoke + audit envelope), bound to the LIVE production deployment.
    await this.emitGroupDeployVerified(plan, target, {
      deploymentId: transition.deploymentId,
      url: verified.url,
      state: verified.state,
      smokeStatus: verified.smokeStatus,
    });
    const release = await this.readBackRelease(plan, target, transition.deploymentId);
    return {
      release: {
        releaseInstanceId: release.releaseInstanceId,
        deploymentId: transition.deploymentId,
        artifactDigest: artifact.artifactDigest,
      },
    };
  }

  /** Append the group's `deploy.verified` on the tail run (the shape mq-15 / ds-6 read). */
  private async emitGroupDeployVerified(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    verified: { deploymentId: string; url: string; state: string; smokeStatus: number },
  ): Promise<void> {
    await runWithJobOrgId(plan.orgId, async () => {
      await this.deps.eventStore.append({
        runId: plan.tailRunId,
        specId: plan.tailSpecId,
        projectId: plan.projectId,
        orgId: plan.orgId,
        eventType: "deploy.verified",
        payload: groupDeployVerifiedPayload(plan, target, verified),
      });
    });
  }

  async currentPriorGood(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    exceptReleaseInstanceId: string;
  }): Promise<PriorGoodRelease | undefined> {
    const { plan } = input;
    // Finding 1: the prior-good is the release the just-promoted production release SUPERSEDED
    // — it is now state `superseded` (promote demoted it), so a `latestLive` (state='live')
    // lookup would ALWAYS miss it and the loop would never roll back. Read the DURABLE promote
    // lineage instead: the production release records the release it superseded as its
    // `previousReleaseInstanceId`. A null predecessor is a genuine no-prior-good (first-ever
    // release, nothing to roll back to) ⇒ undefined ⇒ the core ends needs_attention.
    return runWithOrgScope(this.deps.pool, plan.orgId, async (client): Promise<PriorGoodRelease | undefined> => {
      const production = await ReleaseInstancesStore.getById(client, plan.orgId, input.exceptReleaseInstanceId);
      const priorId = production?.previousReleaseInstanceId ?? null;
      if (priorId === null) return undefined;
      const prior = await ReleaseInstancesStore.getById(client, plan.orgId, priorId);
      if (prior === undefined) return undefined;
      return { releaseInstanceId: prior.releaseInstanceId, artifactDigest: prior.artifactDigest };
    });
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
    if (this.deps.deployAdapter !== undefined) return this.deps.deployAdapter;
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

  /**
   * Poll the provider deployment status to READY (unbounded while advancing) + smoke-check the
   * URL. Returns the verification (final state + resolved URL + smoke status) so the caller can
   * bind the group's `deploy.verified` to the live deployment. Throws LOUD on a failure/stuck
   * terminal or an unreachable URL.
   */
  private async verifyReadiness(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    deploymentId: string,
    heartbeat?: () => Promise<void>,
  ): Promise<{ state: string; url: string; smokeStatus: number }> {
    const ref = this.ref(target);
    const adapter = this.adapter(plan);
    const { poll } = await pollUntilTerminal<{ state: string; ready: boolean; failed: boolean; url: string }>({
      readState: async () => {
        // Per-poll liveness sign-of-life: an unbounded-but-progressing verify keeps the delivery
        // claim fresh so a live owner is NEVER taken over (Finding 5 — no double-deploy). A lost
        // claim throws here, aborting the drive before any further external effect.
        if (heartbeat !== undefined) await heartbeat();
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
    return { state: poll.state, url: poll.url, smokeStatus: smoke };
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
