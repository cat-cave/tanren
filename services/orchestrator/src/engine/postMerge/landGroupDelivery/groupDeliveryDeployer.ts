// mq-13 PRODUCTION group-delivery deployer — the honest wrapper that drives the REAL
// DeployAdapter SP-6 lifecycle (buildArtifact / applyPreview / promote / rollback /
// teardownPreview), the REAL ProofBackedWebDemo, and the durable release-instance store for
// ONE completed land group. The fail-closed decision tree lives in `groupDeliveryCore.ts`.

import type pg from "pg";
import {
  buildDeployAdapter,
  DIRECT_API_ADAPTER_KIND,
  fetchUrlReachabilityProbe,
} from "../../deploy/buildDeployAdapter.js";
import { EventReapFailureReporter } from "../../deploy/reapFailureReporter.js";
import type { DeployAdapter, UrlReachabilityProbe, VerifyPollPolicy } from "../../contracts/deployAdapter.js";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../contracts/integrationAuthority.js";
import type { EventStore } from "../../eventStore.js";
import type { ReleaseInstancesRepository } from "../../repositories/releaseInstances.js";
import { PgBehaviorRevisionResolver } from "../../repositories/behaviorRevisionResolver.js";
import { PgReleaseInstancesRepository } from "../../repositories/index.js";
import {
  buildProofBackedWebDemo,
  isProofBackedLoadFailure,
  type ProofBackedWebDemo,
} from "../../demo/proofBackedWebDemo.js";
import { createLogger } from "../../observability/logger.js";
import type { SecretStore, DeployHttpTransport } from "../deployOnMergeDeployDeps.js";
import {
  currentLiveGroupRelease,
  currentPriorGoodRelease,
  emitGroupDeployVerified,
  ensureGroupDeployVerified,
  readBackGroupRelease,
  findGroupLiveProductionRelease,
  findGroupRelease,
  resolveGroupBehaviorRevisionIds,
} from "./groupDeliveryDeployerHelpers.js";
import {
  LandGroupDeliveryClaimLostError,
  type GroupArtifact,
  type GroupDeliveryDeployer,
  type GroupDeliveryPlan,
  type GroupDemoOutcome,
  type GroupPreview,
  type GroupPreviewOutcome,
  type GroupProduction,
  type GroupPromoteOutcome,
  type GroupReleaseHandle,
  type PriorGoodRelease,
  type ResolvedGroupDeployTarget,
} from "./groupDeliveryCore.js";
import { PgGroupDeliveryAuthority, type GroupDeliveryAuthority } from "./groupDeliveryAuthority.js";
import { GroupDeliveryProviderEffects } from "./groupDeliveryProviderEffects.js";

const log = createLogger("land-group-delivery-deployer");

/**
 * The INTENT-MARKER seam (Finding A): a fenced, durable "about to fire the external effect" marker
 * committed BEFORE the irreversible external call, read on takeover to detect a maybe-fired effect.
 * A subset of `PgLandGroupDeliveryStore` (structurally satisfied); the factory wires the store.
 */
export interface GroupIntentStore {
  writeIntent(orgId: string, landGroupId: string, token: string, step: "preview" | "promote"): Promise<boolean>;
  readIntent(orgId: string, landGroupId: string, step: "preview" | "promote"): Promise<boolean>;
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
  /**
   * The intent-marker store (INTENT-MARKER-BEFORE-EFFECT). REQUIRED (this round's Finding B): the
   * irreversible-effect path must be intent-fenced, so a mis-composition is a COMPILE error. The
   * runtime guard in `markIntentOrAbort` remains as defense-in-depth against a type-cast bypass.
   */
  readonly intentStore: GroupIntentStore;
  /** Injected only by focused tests; production resolves a fresh exact-operation org grant. */
  readonly authority?: GroupDeliveryAuthority;
}

/** The `deploy.<provider>` provider kind maps onto the `deployRef.provider`. */
export class ProductionGroupDeliveryDeployer implements GroupDeliveryDeployer {
  private readonly releaseInstances: ReleaseInstancesRepository;
  private readonly behaviorRevisions: PgBehaviorRevisionResolver;
  private readonly proofBackedWebDemo: ProofBackedWebDemo;
  private readonly urlProbe: UrlReachabilityProbe;
  private readonly authority: GroupDeliveryAuthority;
  private readonly effects: GroupDeliveryProviderEffects;

  constructor(private readonly deps: ProductionGroupDeliveryDeployerDeps) {
    this.releaseInstances = deps.releaseInstances ?? new PgReleaseInstancesRepository(deps.pool);
    this.behaviorRevisions = deps.behaviorRevisions ?? new PgBehaviorRevisionResolver(deps.pool);
    this.proofBackedWebDemo =
      deps.proofBackedWebDemo ?? buildProofBackedWebDemo(deps.pool, deps.eventStore, deps.secrets);
    this.urlProbe = deps.urlProbe ?? fetchUrlReachabilityProbe();
    this.authority = deps.authority ?? new PgGroupDeliveryAuthority(deps.pool);
    this.effects = new GroupDeliveryProviderEffects({
      adapterFor: (plan) => this.adapter(plan),
      urlProbe: this.urlProbe,
      ...(deps.verifyPoll !== undefined && { verifyPoll: deps.verifyPoll }),
      grantFor: (plan, target, operation, operationTarget) => this.grant(plan, target, operation, operationTarget),
    });
  }

  async buildArtifact(input: { plan: GroupDeliveryPlan; target: ResolvedGroupDeployTarget }): Promise<GroupArtifact> {
    const { plan, target } = input;
    const deployGrant = await this.grant(plan, target, "deploy", {
      resourceId: target.appId,
      sourceRepo: target.repoSlug,
      sourceRef: plan.mainSha,
    });
    return this.effects.buildArtifact(plan, target, deployGrant);
  }

  async applyPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
    token?: string;
    heartbeat?: () => Promise<void>;
  }): Promise<GroupPreviewOutcome> {
    const { plan, target, artifact } = input;
    // Authority is the first operation. An absent/invalid grant rejects before either
    // the persistence completion check or any provider call.
    await this.grant(plan, target, "deploy", {
      resourceId: target.appId,
      sourceRepo: target.repoSlug,
      sourceRef: plan.mainSha,
    });
    // COMPLETION CHECK: a persisted release for THIS group's artifact already exists ⇒ REUSE it
    // (idempotent — a takeover after the prior owner persisted the preview).
    const existing = await findGroupRelease(this.deps.pool, plan, target, artifact.artifactDigest);
    if (existing !== undefined) {
      return {
        kind: "applied",
        preview: {
          release: {
            releaseInstanceId: existing.releaseInstanceId,
            deploymentId: existing.deploymentId,
            artifactDigest: artifact.artifactDigest,
          },
          previewDeploymentId: existing.deploymentId,
        },
      };
    }
    // INTENT CHECK (Finding A/D): a preview intent WITHOUT a persisted preview ⇒ the external
    // deploy MAY have fired + orphaned for a dead owner ⇒ AMBIGUOUS. Degrade (never apply a SECOND
    // preview); the orphan is reconciled out-of-band (preview TTL) + surfaced via needs_attention.
    if (
      this.deps.intentStore !== undefined &&
      (await this.deps.intentStore.readIntent(plan.orgId, plan.landGroupId, "preview"))
    ) {
      log.warn("preview intent present without a persisted preview — ambiguous, degrading (orphaned preview)", {
        landGroupId: plan.landGroupId,
      });
      return { kind: "ambiguous" };
    }
    const behaviorRevisionIds = await resolveGroupBehaviorRevisionIds(this.deps.pool, this.behaviorRevisions, plan);
    // FIRE: write the preview intent FENCED (also the immediate fence-recheck, Finding C) COMMITTED
    // BEFORE the external deploy. A lost fence ⇒ abort before firing.
    await this.markIntentOrAbort(plan, input.token, "preview");
    // The early authority check above deliberately precedes all durable work, but its lease may
    // expire while that work runs. Resolve the same exact grant again at the effect boundary.
    const grant = await this.grant(plan, target, "deploy", {
      resourceId: target.appId,
      sourceRepo: target.repoSlug,
      sourceRef: plan.mainSha,
    });
    const preview = await this.effects.applyPreview(plan, target, artifact, behaviorRevisionIds, grant);
    // NO verify here — the caller runs verifyPreview separately so a verify failure can tear
    // the preview down (Finding 4) instead of leaking it. The preview release is persisted.
    const release = await readBackGroupRelease(this.releaseInstances, plan, target, preview.deploymentId);
    return {
      kind: "applied",
      preview: {
        release: {
          releaseInstanceId: release.releaseInstanceId,
          deploymentId: preview.deploymentId,
          artifactDigest: artifact.artifactDigest,
        },
        previewDeploymentId: preview.deploymentId,
      },
    };
  }

  /**
   * Write the step's intent marker FENCED BEFORE the external effect (also the atomic immediate
   * fence-recheck; a lost fence ⇒ throw claim-lost, abort before firing). FAIL-CLOSED (Finding B):
   * the intent store + fence token are type-REQUIRED; this runtime guard is defense-in-depth against
   * a type-cast bypass — a missing either MUST NOT fall through to firing without an intent marker.
   */
  private async markIntentOrAbort(
    plan: GroupDeliveryPlan,
    token: string | undefined,
    step: "preview" | "promote",
  ): Promise<void> {
    if (this.deps.intentStore === undefined || token === undefined) {
      throw new Error(
        `land-group delivery: refusing to fire the ${step} external effect without an intent marker ` +
          "(mis-composed deployer — the intent store + fence token are REQUIRED; never fire-without-intent)",
      );
    }
    if (!(await this.deps.intentStore.writeIntent(plan.orgId, plan.landGroupId, token, step))) {
      throw new LandGroupDeliveryClaimLostError(plan.landGroupId);
    }
  }

  async verifyPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    preview: GroupPreview;
    heartbeat?: () => Promise<void>;
  }): Promise<void> {
    // Preview-safe readiness: poll status to READY + smoke-check the URL (NO markLive). Throws
    // LOUD when the preview never becomes reachable (the core tears it down → preview_failed).
    await this.effects.verifyReadiness(input.plan, input.target, input.preview.previewDeploymentId, input.heartbeat);
  }

  async demo(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    release: GroupReleaseHandle;
    environment: "preview" | "production";
  }): Promise<GroupDemoOutcome> {
    const { plan, target, release } = input;
    const record = await readBackGroupRelease(this.releaseInstances, plan, target, release.deploymentId);
    try {
      const result = await this.proofBackedWebDemo.demo(
        {
          runId: plan.tailRunId,
          specId: plan.tailSpecId,
          projectId: plan.projectId,
          orgId: plan.orgId,
          ...(input.environment === "production"
            ? { deliveryRunId: plan.deliveryRunId }
            : { skipLiveEffectAssertions: true }),
        },
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
    await this.effects.teardownPreview(plan, target, input.previewDeploymentId, grant);
  }

  async promote(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
    preview: GroupPreview;
    token?: string;
    heartbeat?: () => Promise<void>;
  }): Promise<GroupPromoteOutcome> {
    const { plan, target, artifact, preview } = input;
    // Authority is the first operation. An absent/invalid promote grant rejects before
    // any durable release read, intent marker read/write, or provider effect.
    await this.grant(plan, target, "promote", {
      resourceId: target.appId,
      deploymentId: preview.previewDeploymentId,
    });
    const current = await currentLiveGroupRelease(this.deps.pool, plan, target);
    // COMPLETION CHECK: THIS group's artifact is ALREADY the live production release ⇒ the promote
    // has COMMITTED. NO-OP — but ENSURE `deploy.verified` is emitted (Finding B: a prior owner may
    // have committed the live release then DIED before appending it; without this the group would
    // have a live deploy but no deploy.verified → mq-15/ds-6 starve). Idempotent (no double-emit).
    if (
      current !== undefined &&
      current.artifactDigest === artifact.artifactDigest &&
      current.sourceRef === plan.mainSha
    ) {
      log.info("group promote already committed — idempotent no-op (takeover-safe)", {
        landGroupId: plan.landGroupId,
        releaseInstanceId: current.releaseInstanceId,
      });
      await ensureGroupDeployVerified(
        { pool: this.deps.pool, eventStore: this.deps.eventStore, urlProbe: this.urlProbe },
        plan,
        target,
        current,
      );
      return {
        kind: "promoted",
        production: {
          release: {
            releaseInstanceId: current.releaseInstanceId,
            deploymentId: current.deploymentId,
            artifactDigest: artifact.artifactDigest,
          },
        },
      };
    }
    // INTENT CHECK (Finding A): a promote intent present WITHOUT a committed live release ⇒ the
    // EXTERNAL promote MAY have fired for an owner that DIED before the DB commit ⇒ AMBIGUOUS.
    // DEGRADE — NEVER re-fire (a double production deploy is unacceptable; a conservative degrade
    // requiring an operator/re-drive is acceptable). This closes the external-before-DB gap that
    // check-then-act cannot.
    if (
      this.deps.intentStore !== undefined &&
      (await this.deps.intentStore.readIntent(plan.orgId, plan.landGroupId, "promote"))
    ) {
      log.warn("promote intent present without a committed live release — ambiguous, degrading (never re-fire)", {
        landGroupId: plan.landGroupId,
      });
      return { kind: "ambiguous" };
    }
    // FIRE: write the promote intent FENCED (the atomic immediate fence-recheck, Finding C)
    // COMMITTED IMMEDIATELY BEFORE the external promote. A lost fence ⇒ abort before firing. This
    // is the tightest boundary — write intent, then the external call, then the durable completion.
    await this.markIntentOrAbort(plan, input.token, "promote");
    // Preserve the early fail-closed authority check, then refresh the exact operation lease at
    // the provider boundary so durable checks and intent persistence cannot consume its TTL.
    const grant = await this.grant(plan, target, "promote", {
      resourceId: target.appId,
      deploymentId: preview.previewDeploymentId,
    });
    const prior = current;
    const transition = await this.effects.promote(
      plan,
      target,
      artifact,
      preview,
      prior?.releaseInstanceId ?? null,
      grant,
    );
    // Production verify (the markLive path is correct here — the release IS production now).
    const verified = await this.effects.verifyReadiness(plan, target, transition.deploymentId, input.heartbeat);
    // Finding 2: durably emit the GROUP's `deploy.verified` on the tail run (idempotently) so mq-15
    // seals + ds-6 joins from the group's evidence. Bound to the LIVE production deployment.
    await emitGroupDeployVerified({ pool: this.deps.pool, eventStore: this.deps.eventStore }, plan, target, {
      deploymentId: transition.deploymentId,
      url: verified.url,
      state: verified.state,
      smokeStatus: verified.smokeStatus,
    });
    const release = await readBackGroupRelease(this.releaseInstances, plan, target, transition.deploymentId);
    return {
      kind: "promoted",
      production: {
        release: {
          releaseInstanceId: release.releaseInstanceId,
          deploymentId: transition.deploymentId,
          artifactDigest: artifact.artifactDigest,
        },
      },
    };
  }

  async recoverDeployVerified(input: { plan: GroupDeliveryPlan; target: ResolvedGroupDeployTarget }): Promise<void> {
    // Finding A (HIGH): a genuinely-LIVE group must ALWAYS converge to having its `deploy.verified`.
    // If a prior attempt finalized `needs_attention` AFTER `adapter.promote` marked the release
    // live but a transient throw (verify/emit) skipped the emit, the terminal row blocks re-entry —
    // so this RECOVERY runs on EVERY wake, BEFORE the claim, idempotently: if the group has a
    // committed live production release with no `deploy.verified`, emit it (else a clean no-op).
    const live = await findGroupLiveProductionRelease(this.deps.pool, input.plan, input.target);
    if (live === undefined) return;
    await ensureGroupDeployVerified(
      { pool: this.deps.pool, eventStore: this.deps.eventStore, urlProbe: this.urlProbe },
      input.plan,
      input.target,
      live,
    );
  }

  async currentPriorGood(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    exceptReleaseInstanceId: string;
  }): Promise<PriorGoodRelease | undefined> {
    return currentPriorGoodRelease(this.deps.pool, input.plan, input.exceptReleaseInstanceId);
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
    await this.effects.rollback(plan, target, priorGood, grant);
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

  private async grant(
    plan: GroupDeliveryPlan,
    target: ResolvedGroupDeployTarget,
    operation: IntegrationPrivilegedOperation,
    operationTarget: IntegrationOperationTarget,
  ): Promise<OrgGrant> {
    return this.authority.require(plan, target, operation, operationTarget);
  }
}
