// mq-13 LandGroupDeliveryLoop — the ONE new production entry point, driven FIRST in
// PostMergeSubscriber.runChain. For a member run whose `land_groups` row is COMPLETE (the tail
// run carrying `merge.land_group.completed`), it turns the completed group into ONE durable,
// proof-backed delivery loop: resolve the exact group / main SHA / deploy target, CLAIM the
// group (idempotency — exactly one receipt/artifact), and drive the fail-closed decision tree
// (build → preview → verify → demo → promote → production demo → rollback/repair) via the
// injected deployer + attribution. It emits the group's own `deploy.verified` / `demo.completed`
// (through the deployer's real ProofBackedWebDemo) on the tail run, so mq-15 seals and ds-6
// joins from the GROUP's evidence — never once per member.
//
// A group member's per-run in-17 delivery is MEMBERSHIP-GUARDED off (see the guard in
// deliveryDagDriver), so a group deploys ONCE, not once per member. This loop never bypasses
// MergeAuthorityV2 (the merge already happened); it only activates the merged group's release.

import type pg from "pg";
import { createLogger } from "../../observability/logger.js";
import type { RunMergeWatcher } from "../subscriber.js";
import {
  LandGroupDeliveryClaimLostError,
  runGroupDelivery,
  type GroupDeliveryDeployer,
  type GroupDeliveryOutcome,
  type GroupRegressionAttribution,
  type ResolvedGroupDeployTarget,
} from "./groupDeliveryCore.js";
import { resolveCompletedGroup, resolveGroupDeployTarget } from "./landGroupDeliveryReads.js";
import { PgLandGroupDeliveryStore } from "./landGroupDeliveryStore.js";
import { startClaimHeartbeat } from "./claimHeartbeat.js";

const log = createLogger("land-group-delivery");

export interface LandGroupDeliveryLoopDeps {
  readonly pool: pg.Pool;
  readonly deployer: GroupDeliveryDeployer;
  readonly attribution: GroupRegressionAttribution;
  /** Injectable durable store (defaults to the Pg store over `pool`). */
  readonly store?: PgLandGroupDeliveryStore;
  /** The continuous-renew cadence for the liveness heartbeat (tests set a tiny value). */
  readonly heartbeatIntervalMs?: number;
  /** The takeover lease a STALE in_progress claim may be reclaimed past (SQL interval; tests tiny). */
  readonly claimLeaseInterval?: string;
}

/** The fixed, non-secret reason each terminal disposition records on the delivery event. */
const OUTCOME_REASON: Record<GroupDeliveryOutcome["state"], string> = {
  preview_failed: "preview verification or proof-backed demo failed; no promotion, preview torn down",
  completed: "group promoted to production and its production proof-backed demo passed",
  rolled_back: "production proof-backed demo regressed; traffic rolled back to the prior-good release",
  needs_attention:
    "production regression with no prior-good release to roll back to, or the regression could not be attributed to a single member",
};

export class LandGroupDeliveryLoop implements RunMergeWatcher {
  private readonly store: PgLandGroupDeliveryStore;

  constructor(private readonly deps: LandGroupDeliveryLoopDeps) {
    this.store = deps.store ?? new PgLandGroupDeliveryStore(deps.pool);
  }

  async check(runId: string): Promise<void> {
    if (runId === "") return;
    // 1. Detect + resolve a COMPLETED land group from its tail run (fail-closed to no-op).
    const detection = await resolveCompletedGroup(this.deps.pool, runId);
    if (detection === undefined) return;
    const { plan } = detection;

    // 2. Resolve the group's deploy target. No resolvable target ⇒ nothing to deliver (a group
    //    with no deploy target would not be sealed by mq-15 either) — a clean no-op.
    const resolution = await resolveGroupDeployTarget(this.deps.pool, detection.lineage);
    if (resolution.kind !== "configured") {
      log.info("completed land group has no resolvable deploy target — skipping delivery (no-op)", {
        landGroupId: plan.landGroupId,
        resolution: resolution.kind,
      });
      return;
    }
    const target: ResolvedGroupDeployTarget = {
      provider: resolution.target.provider,
      appId: resolution.target.appId,
      repoSlug: detection.repoSlug,
      policyVersion: resolution.target.policyVersion,
    };

    // 3. CLAIM the group (idempotency + cross-process ownership). A terminal row ⇒ exactly one
    //    receipt/artifact already delivered — no-op. A non-terminal `in_progress` ⇒ another
    //    owner is driving — no-op this pass.
    const claim = await this.store.claim({
      orgId: plan.orgId,
      projectId: plan.projectId,
      landGroupId: plan.landGroupId,
      mainSha: plan.mainSha,
      ...(this.deps.claimLeaseInterval !== undefined && { leaseInterval: this.deps.claimLeaseInterval }),
    });
    if (claim.kind === "exists") {
      log.info("land group delivery already claimed/terminal — no-op", {
        landGroupId: plan.landGroupId,
        state: claim.state,
      });
      return;
    }

    // 4. Own the delivery. A CONTINUOUS background HEARTBEAT (Finding A) renews the liveness lease
    // throughout the whole drive — INCLUDING during the long external calls (build/applyPreview/
    // promote/demo) — so a genuinely-LIVE owner NEVER ages out and is never taken over mid-effect.
    // `heartbeat()` is the authoritative fence-recheck the drive calls before each irreversible
    // external effect (and per verify poll): a lost claim throws and aborts WITHOUT finalizing (the
    // new owner drives to terminal — never a double external effect, never a double finalize).
    const { token } = claim;
    const beat = startClaimHeartbeat({
      renewer: this.store,
      orgId: plan.orgId,
      landGroupId: plan.landGroupId,
      token,
      ...(this.deps.heartbeatIntervalMs !== undefined && { intervalMs: this.deps.heartbeatIntervalMs }),
    });
    try {
      const outcome = await runGroupDelivery({
        deployer: this.deps.deployer,
        attribution: this.deps.attribution,
        plan,
        target,
        token,
        heartbeat: () => beat.assertOwned(),
      });
      await this.store.finalize({ plan, token, outcome, reason: OUTCOME_REASON[outcome.state] });
      log.info("land group delivery finalized", {
        landGroupId: plan.landGroupId,
        state: outcome.state,
        disposition: outcome.disposition,
      });
    } catch (error) {
      if (error instanceof LandGroupDeliveryClaimLostError) {
        // A fresh worker took over this stale claim — abort WITHOUT finalizing (the new owner
        // owns the terminal decision). The finalize below is fenced anyway, but returning here
        // keeps the intent explicit + avoids a needless fenced no-op write.
        log.warn("land group delivery claim taken over mid-drive — deferring to the new owner", {
          landGroupId: plan.landGroupId,
        });
        return;
      }
      // An UNEXPECTED throw (a stage the deployer could not confirm) — record a durable
      // needs_attention receipt so the group never stays stranded `in_progress`, and re-throw
      // so the subscriber's isolation `.catch` logs it (never silently swallowed). The finalize
      // is FENCED on the token: if the claim was lost, it is a safe no-op.
      log.error("land group delivery failed unexpectedly", { landGroupId: plan.landGroupId }, error);
      await this.store.finalize({
        plan,
        token,
        outcome: needsAttentionOutcome(),
        reason: "land group delivery loop failed before reaching a terminal decision",
      });
      throw error;
    } finally {
      // Stop the background renew loop — the drive reached a terminal (finalize) or aborted.
      beat.stop();
    }
  }
}

function needsAttentionOutcome(): GroupDeliveryOutcome {
  return {
    state: "needs_attention",
    disposition: "needs_attention",
    artifactDigest: null,
    previewReleaseInstanceId: null,
    productionReleaseInstanceId: null,
    rollbackReleaseInstanceId: null,
    attributedRunId: null,
  };
}
