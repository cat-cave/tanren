import type { ResolutionAuthority } from "../contracts/resolutionAuthority.js";
import type { ResolutionJob } from "../contracts/resolutionStage.js";
import type pg from "pg";
import { PgRepairRouter, type RepairRouter } from "../workflow/repairRouting.js";
import { PostMergeReproofCoordinator } from "../verification/postMergeReproof/coordinator.js";

export type { RepairRouter } from "../workflow/repairRouting.js";
// rv-19 deploy-side settlement, re-exported through the SAME production-resolution seam the
// walker + retry route already import from, so neither adds a fresh module dependency.
export {
  applyReproofDeployOutcome,
  PostMergeReproofCoordinator,
} from "../verification/postMergeReproof/coordinator.js";
// rv-16a persisted post-merge PRODUCTION behavior verdict, re-exported through the SAME
// production-resolution seam the walker + retry route import from (no fresh module dep).
export {
  recordPostMergeBehaviorVerdict,
  buildPostMergeBehaviorAcceptanceVerifier,
  PostMergeBehaviorAcceptanceVerifier,
} from "../verification/postMergeReproof/behaviorAcceptanceVerdict.js";
// rv-16b behavior-aware regression bisection, re-exported through the SAME seam the walker +
// retry route import from (no fresh module dep for the route).
export {
  recordRegressionBisections,
  type RegressionBisector,
} from "../verification/postMergeReproof/regressionBisection.js";
export { buildRegressionBisector } from "../verification/postMergeReproof/regressionBisectionBuild.js";

/** Production composition keeps the fail-closed blocked-decision seam together. */
export function buildProductionRepairRouter(pool: pg.Pool): RepairRouter {
  return new PgRepairRouter(pool);
}

/** The live rv-19 deploy-side settlement coordinator over the control pool. */
export function buildPostMergeReproofCoordinator(pool: pg.Pool): PostMergeReproofCoordinator {
  return new PostMergeReproofCoordinator({ pool });
}

/**
 * Record the sole resolution decision after a production stage has durably
 * written its evidence and before its lease can be terminally settled.
 *
 * Every live production execution surface must use this helper. A missing or
 * failed authority deliberately throws so its job remains reclaimable instead
 * of becoming a completed, decision-less verification.
 */
export async function authorizeProductionResolution(
  authority: Pick<ResolutionAuthority, "authorize"> | undefined,
  job: Pick<ResolutionJob, "orgId" | "id" | "stage">,
  repairRouter?: RepairRouter,
): Promise<void> {
  if (job.stage !== "production") return;
  if (authority === undefined) {
    throw new Error("production resolution work has no ResolutionAuthority — fail closed");
  }
  const decision = await authority.authorize({ orgId: job.orgId, resolutionJobId: job.id });
  if (decision.decision !== "blocked") return;
  if (repairRouter === undefined) {
    throw new Error("blocked production resolution has no repair router — fail closed");
  }
  await repairRouter.route({ orgId: job.orgId, resolutionDecisionId: decision.id });
}
