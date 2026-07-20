// mq-13 PURE, DB-free group-delivery orchestrator — the fail-closed decision tree the
// LandGroupDeliveryLoop drives over injected collaborators. Every trap class is an
// EXPLICIT branch here, so each negative control is unit-testable with fakes and NO
// database:
//
//   • Build ONE artifact per completed group (exactly one — build is the first, single call).
//   • NO promotion until the group's preview verification AND proof-backed demo pass —
//     a failed preview tears the preview down and returns `preview_failed`, never promotes.
//     (The gravest prohibited fail-open: promoting a failed preview / separate members as
//      if the whole group were verified.)
//   • On a failing PRODUCTION proof: call the adapter's REAL `rollback` to the persisted
//     prior-good release. A rollback that does NOT genuinely succeed (throws) NEVER claims
//     `rolled_back` — it degrades to `needs_attention`. A NO-prior-good regression ends
//     `needs_attention`, NEVER a pretended rollback.
//   • Attribution to one member calls mq-10's repair router ONLY when causal replay
//     localizes the regression to EXACTLY one member run; an ambiguous / inconclusive
//     replay ends `needs_attention` with NO fabricated repair target.
//
// The loop shell (`landGroupDeliveryLoop.ts`) resolves the completed group + deploy target,
// claims the durable row, calls `runGroupDelivery`, and persists the terminal receipt +
// event. This module never touches a pool.

import type { LandGroupDeliveryDisposition, LandGroupDeliveryState } from "../../contracts/landGroupDeliveryReceipt.js";

/** The resolved plan for one completed land group's delivery (NON-SECRET identities). */
export interface GroupDeliveryPlan {
  readonly orgId: string;
  readonly projectId: string;
  readonly landGroupId: string;
  /** The completed land group's main SHA (from `merge.land_group.completed`). */
  readonly mainSha: string;
  /** The tail member run that carries the completed event — the demo/event emission target. */
  readonly tailRunId: string;
  /** The tail member spec (the demo target's spec coordinate). */
  readonly tailSpecId: string;
  /** The ordered member run ids (canonical member-key order). */
  readonly memberRunIds: readonly string[];
  /** The ordered member spec ids (canonical member-key order; parallel to memberRunIds). */
  readonly memberSpecIds: readonly string[];
}

/** The resolved deploy target (provider + app + source ref) the group delivers onto. */
export interface ResolvedGroupDeployTarget {
  readonly provider: string;
  readonly appId: string;
  /** The repo slug (`owner/name`) the merged source is fetched from. */
  readonly repoSlug: string;
  readonly policyVersion: number;
}

/** The built group artifact identity (the canonical SP-3 digest minted once). */
export interface GroupArtifact {
  readonly artifactDigest: string;
  readonly deploymentId: string;
}

/** A persisted release handle the loop tracks by its release-instance id + provider deployment. */
export interface GroupReleaseHandle {
  readonly releaseInstanceId: string;
  readonly deploymentId: string;
  readonly artifactDigest: string;
}

/** The preview release + its provider preview handle (for teardown). */
export interface GroupPreview {
  readonly release: GroupReleaseHandle;
  readonly previewDeploymentId: string;
}

/** The promoted production release. */
export interface GroupProduction {
  readonly release: GroupReleaseHandle;
}

/** A proof-backed demo outcome, folded to a fail-closed pass/fail (a load/observe throw ⇒ NOT ok). */
export interface GroupDemoOutcome {
  /** PASS only when the proof-backed demo ran AND every behavior passed (failed === 0). */
  readonly ok: boolean;
  /** A non-secret reason when the demo did not pass (for the durable disposition). */
  readonly reason: string;
}

/** The prior-good release traffic rolls back to. */
export interface PriorGoodRelease {
  readonly releaseInstanceId: string;
  readonly artifactDigest: string;
}

/**
 * The injected deployer port — the REAL DeployAdapter SP-6 lifecycle + ProofBackedWebDemo +
 * release-instance persistence behind a testable seam. The production impl (see
 * `groupDeliveryDeployer.ts`) wires the real adapter/grant/demo; a fake drives every branch.
 * A method that CANNOT confirm its external effect THROWS — the orchestrator's rollback
 * branch is the only place a throw is caught (a rollback that did not genuinely succeed must
 * NOT claim `rolled_back`); every other throw propagates to the loop shell (→ needs_attention).
 */
export interface GroupDeliveryDeployer {
  /** BUILD exactly ONE artifact from the group main SHA; mint its canonical SP-3 digest. */
  buildArtifact(input: { plan: GroupDeliveryPlan; target: ResolvedGroupDeployTarget }): Promise<GroupArtifact>;
  /** Apply a PREVIEW of the built artifact, verify it live, and persist the preview release. */
  applyPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
  }): Promise<GroupPreview>;
  /** Run the PROOF-BACKED demo against a release; a load/observe failure folds to `ok:false`. */
  demo(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    release: GroupReleaseHandle;
    environment: "preview" | "production";
  }): Promise<GroupDemoOutcome>;
  /** TEAR DOWN a preview env (idempotent) — the fail-closed cleanup after a failed preview. */
  teardownPreview(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    previewDeploymentId: string;
  }): Promise<void>;
  /** PROMOTE the verified preview artifact to production, verify it live, persist the live release. */
  promote(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    artifact: GroupArtifact;
    preview: GroupPreview;
  }): Promise<GroupProduction>;
  /** The current LIVE production release (prior-good) EXCLUDING the just-promoted one, or undefined. */
  currentPriorGood(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    exceptReleaseInstanceId: string;
  }): Promise<PriorGoodRelease | undefined>;
  /** The REAL traffic rollback to the prior-good release — throws if it does not genuinely succeed. */
  rollback(input: {
    plan: GroupDeliveryPlan;
    target: ResolvedGroupDeployTarget;
    priorGood: PriorGoodRelease;
    brokenProduction: GroupProduction;
  }): Promise<void>;
}

/** The causal-replay + repair-routing seam (rv-16b bisector → mq-10 router). */
export type GroupAttributionResult =
  | {
      readonly kind: "attributed";
      readonly runId: string;
      readonly specId: string;
      readonly findingIds: readonly string[];
      readonly reasonCodes: readonly string[];
      readonly evaluationId: string;
    }
  | { readonly kind: "unattributed"; readonly reason: string };

export interface GroupRegressionAttribution {
  /** Causal-replay the production regression; localize to EXACTLY one member run, or unattributed. */
  attribute(input: {
    plan: GroupDeliveryPlan;
    production: GroupProduction;
    priorGood: PriorGoodRelease;
  }): Promise<GroupAttributionResult>;
  /** Route the attributed member to mq-10's repair router (called ONLY on an `attributed` result). */
  route(input: {
    plan: GroupDeliveryPlan;
    attributed: Extract<GroupAttributionResult, { kind: "attributed" }>;
  }): Promise<void>;
}

/** The terminal outcome of a group delivery — persisted as the receipt + emitted as the event. */
export interface GroupDeliveryOutcome {
  readonly state: Exclude<LandGroupDeliveryState, "in_progress">;
  readonly disposition: LandGroupDeliveryDisposition;
  readonly artifactDigest: string | null;
  readonly previewReleaseInstanceId: string | null;
  readonly productionReleaseInstanceId: string | null;
  readonly rollbackReleaseInstanceId: string | null;
  readonly attributedRunId: string | null;
}

/**
 * Drive the fail-closed group-delivery decision tree. Pure orchestration over the injected
 * deployer + attribution collaborators — every branch is a unit-testable trap-class control.
 * An unexpected throw from a NON-rollback stage propagates to the loop shell (→ needs_attention);
 * a rollback that does not genuinely succeed is caught HERE and degrades to `needs_attention`
 * (never a pretended rollback).
 */
export async function runGroupDelivery(deps: {
  readonly deployer: GroupDeliveryDeployer;
  readonly attribution: GroupRegressionAttribution;
  readonly plan: GroupDeliveryPlan;
  readonly target: ResolvedGroupDeployTarget;
}): Promise<GroupDeliveryOutcome> {
  const { deployer, attribution, plan, target } = deps;

  // 1. Build ONE artifact for the whole completed group (single call ⇒ exactly one artifact).
  const artifact = await deployer.buildArtifact({ plan, target });

  // 2. Apply a preview of the built artifact + verify it live.
  const preview = await deployer.applyPreview({ plan, target, artifact });

  // 3. PROOF-BACKED preview demo. A failed preview proof ⇒ NO promote + tear the preview down
  //    (the gravest fail-open — promoting a failed preview as if the group were verified — is
  //    prohibited here).
  const previewDemo = await deployer.demo({ plan, target, release: preview.release, environment: "preview" });
  if (!previewDemo.ok) {
    await deployer.teardownPreview({ plan, target, previewDeploymentId: preview.previewDeploymentId });
    return {
      state: "preview_failed",
      disposition: "none",
      artifactDigest: artifact.artifactDigest,
      previewReleaseInstanceId: preview.release.releaseInstanceId,
      productionReleaseInstanceId: null,
      rollbackReleaseInstanceId: null,
      attributedRunId: null,
    };
  }

  // 4. Preview verified AND proof-backed demo passed ⇒ PROMOTE to production + verify live.
  const production = await deployer.promote({ plan, target, artifact, preview });

  // 5. PROOF-BACKED production demo (the group's `demo.completed` on the tail run).
  const productionDemo = await deployer.demo({ plan, target, release: production.release, environment: "production" });
  if (productionDemo.ok) {
    return {
      state: "completed",
      disposition: "none",
      artifactDigest: artifact.artifactDigest,
      previewReleaseInstanceId: preview.release.releaseInstanceId,
      productionReleaseInstanceId: production.release.releaseInstanceId,
      rollbackReleaseInstanceId: null,
      attributedRunId: null,
    };
  }

  // 6. PRODUCTION REGRESSION. Resolve the persisted prior-good release to roll traffic back to.
  const priorGood = await deployer.currentPriorGood({
    plan,
    target,
    exceptReleaseInstanceId: production.release.releaseInstanceId,
  });
  if (priorGood === undefined) {
    // NO prior-good release ⇒ needs_attention, NEVER a pretended rollback success.
    return {
      state: "needs_attention",
      disposition: "needs_attention",
      artifactDigest: artifact.artifactDigest,
      previewReleaseInstanceId: preview.release.releaseInstanceId,
      productionReleaseInstanceId: production.release.releaseInstanceId,
      rollbackReleaseInstanceId: null,
      attributedRunId: null,
    };
  }

  // The REAL adapter rollback to the persisted prior-good lineage. A rollback that does not
  // genuinely succeed (throws) NEVER claims `rolled_back` — it degrades to `needs_attention`.
  try {
    await deployer.rollback({ plan, target, priorGood, brokenProduction: production });
  } catch {
    return {
      state: "needs_attention",
      disposition: "needs_attention",
      artifactDigest: artifact.artifactDigest,
      previewReleaseInstanceId: preview.release.releaseInstanceId,
      productionReleaseInstanceId: production.release.releaseInstanceId,
      rollbackReleaseInstanceId: null,
      attributedRunId: null,
    };
  }

  // 7. Rollback succeeded. Causal-replay the regression; route repair ONLY on a single-member
  //    attribution (else needs_attention — NO fabricated repair target).
  const attributed = await attribution.attribute({ plan, production, priorGood });
  if (attributed.kind === "attributed") {
    await attribution.route({ plan, attributed });
    return {
      state: "rolled_back",
      disposition: "repair_routed",
      artifactDigest: artifact.artifactDigest,
      previewReleaseInstanceId: preview.release.releaseInstanceId,
      productionReleaseInstanceId: production.release.releaseInstanceId,
      rollbackReleaseInstanceId: priorGood.releaseInstanceId,
      attributedRunId: attributed.runId,
    };
  }
  return {
    state: "rolled_back",
    disposition: "needs_attention",
    artifactDigest: artifact.artifactDigest,
    previewReleaseInstanceId: preview.release.releaseInstanceId,
    productionReleaseInstanceId: production.release.releaseInstanceId,
    rollbackReleaseInstanceId: priorGood.releaseInstanceId,
    attributedRunId: null,
  };
}
