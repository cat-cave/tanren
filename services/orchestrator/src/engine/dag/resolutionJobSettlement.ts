import type { ResolutionJob, ResolutionStageResult } from "../contracts/resolutionStage.js";
import type { ResolutionJobStore } from "../repositories/resolutionJobs.js";

export type ResolutionJobSettlement = "completed" | "retryable";

const settlementByClassification = {
  product_resolved: "completed",
  product_failure: "completed",
  stale_contract: "completed",
  infra_failure: "retryable",
  inconclusive: "retryable",
} as const satisfies Record<ResolutionStageResult["classification"], ResolutionJobSettlement>;

/**
 * Resolution-stage verdicts, rather than their callers, decide whether the
 * durable job is terminal. Keep the outcome guard alongside the classification
 * mapping so a future result union cannot silently complete an inconclusive run.
 */
export function settlementForResolutionResult(result: ResolutionStageResult): ResolutionJobSettlement {
  const settlement = settlementByClassification[result.classification];
  if ((result.outcome === "inconclusive") !== (settlement === "retryable")) {
    throw new Error(`resolution result ${result.outcome}/${result.classification} has no valid settlement`);
  }
  return settlement;
}

/** Settle an owned lease consistently on every stage execution surface. */
export async function settleResolutionJob(
  store: Pick<ResolutionJobStore, "complete" | "release">,
  job: Pick<ResolutionJob, "orgId" | "id" | "leaseOwner">,
  result: ResolutionStageResult,
): Promise<boolean> {
  if (settlementForResolutionResult(result) === "retryable") {
    return store.release({ orgId: job.orgId, id: job.id, leaseOwner: job.leaseOwner, state: "retryable" });
  }
  return store.complete({ orgId: job.orgId, id: job.id, leaseOwner: job.leaseOwner });
}
