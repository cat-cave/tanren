import type { ResolutionAuthority } from "../contracts/resolutionAuthority.js";
import type { ResolutionJob } from "../contracts/resolutionStage.js";

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
): Promise<void> {
  if (job.stage !== "production") return;
  if (authority === undefined) {
    throw new Error("production resolution work has no ResolutionAuthority — fail closed");
  }
  await authority.authorize({ orgId: job.orgId, resolutionJobId: job.id });
}
