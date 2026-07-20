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

import type pg from "pg";
import {
  buildDeployAdapter,
  DIRECT_API_ADAPTER_KIND,
  fetchUrlReachabilityProbe,
} from "../../deploy/buildDeployAdapter.js";
import { EventReapFailureReporter } from "../../deploy/reapFailureReporter.js";
import { parseDigest } from "../../contracts/cas.js";
import type {
  DeployAdapter,
  DeployRef,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../../contracts/deployAdapter.js";
import type { OrgGrant } from "../../contracts/integrationProvisioner.js";
import type { DeploySource } from "../../provisioners/deployProvisioner.js";
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
import { pollUntilTerminal } from "../../deploy/pollUntilTerminal.js";
import { loadDeployOperationGrant, missingDeployGrantError } from "../deployOnMergeAuthority.js";
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
  /** The intent-marker store (Finding A) — wired by the factory; absent ⇒ no intent gating (tests). */
  readonly intentStore?: GroupIntentStore;
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
    token?: string;
    heartbeat?: () => Promise<void>;
  }): Promise<GroupPreviewOutcome> {
    const { plan, target, artifact } = input;
    const ref = this.ref(target);
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
    // FIRE: write the preview intent FENCED (also the immediate fence-recheck, Finding C) COMMITTED
    // BEFORE the external deploy. A lost fence ⇒ abort before firing.
    await this.markIntentOrAbort(plan, input.token, "preview");
    const behaviorRevisionIds = await resolveGroupBehaviorRevisionIds(this.deps.pool, this.behaviorRevisions, plan);
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
   * Write the step's intent marker FENCED (Finding A) BEFORE the external effect — which is ALSO
   * the atomic immediate fence-recheck (the prior-round Finding C). A lost fence ⇒ throw claim-lost
   * (abort before firing).
   *
   * FAIL-CLOSED (this round's Finding B): the intent store + fence token are REQUIRED before ANY
   * irreversible external effect. A mis-composed deployer (missing either) MUST NOT fall through to
   * firing without an intent marker — that would re-open the double-deploy window. Abort LOUD.
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
    await this.verifyReadiness(input.plan, input.target, input.preview.previewDeploymentId, input.heartbeat);
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
    token?: string;
    heartbeat?: () => Promise<void>;
  }): Promise<GroupPromoteOutcome> {
    const { plan, target, artifact, preview } = input;
    const ref = this.ref(target);
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
    const prior = current;
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
}
