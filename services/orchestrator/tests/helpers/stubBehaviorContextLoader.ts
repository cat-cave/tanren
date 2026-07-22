// Test double for the bh-15 locked behavior-context loader. Used by walker
// tests whose subject is lease/settlement/stage mechanics — NOT the lock itself.
// The real `PgRuntimeBehaviorContextLoader` + its fail-closed guarantees are
// proven in resolutionBehaviorContext.integration.test.ts and wired in
// buildResolutionDagWalker. This stub returns a fixed, valid context so the
// walker's REQUIRED loader dependency is satisfied and stages run locked.
import type { ResolutionJob, RuntimeBehaviorContext } from "../../src/engine/contracts/resolutionStage.js";
import type { RuntimeBehaviorContextLoader } from "../../src/engine/verification/resolutionStages/resolutionBehaviorContext.js";

// Re-exported so a walker test imports its kit (walker + job store + stub loader)
// from ONE module, keeping per-file dependency counts within the lint cap.
export { ResolutionDagWalker } from "../../src/engine/dag/resolutionDagWalker.js";
export { ResolutionJobStore } from "../../src/engine/repositories/resolutionJobs.js";

const STUB_DIGEST = `sha256:${"0".repeat(64)}`;

export function stubBehaviorContextLoader(): RuntimeBehaviorContextLoader {
  return {
    load: (job: ResolutionJob): Promise<RuntimeBehaviorContext> =>
      Promise.resolve({
        contractId: job.contractId,
        issueLoopId: job.issueLoopId,
        releaseInstanceId: job.releaseInstanceId ?? "stub_release",
        artifactDigest: STUB_DIGEST,
        behaviors: [],
        personaRevisionIds: [],
        contextDigest: STUB_DIGEST,
      }),
  };
}
