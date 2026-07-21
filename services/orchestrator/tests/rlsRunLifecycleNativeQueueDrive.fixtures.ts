import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import { driveMultiMemberPass } from "../src/engine/merge/multiMemberAuthorityEmbark.js";
import { PgBatchMergeEventEmitter } from "../src/engine/merge/batchCoordinatorPg.js";
import { PgMergeQueueEventEmitter, type PgMergeQueueModel } from "../src/engine/merge/coordinatorPg.js";
import { buildLifecycleCanonicalAuthority } from "./rlsRunLifecycleCanonicalAuthority.fixtures.js";

/**
 * Complete the coordinator's one-member green branch after the planner's
 * native-queue enqueue: queue claim → CanonicalQueueAuthorityDrive → land group
 * finalization → queue settlement. No per-run merge fallback is available here.
 */
export async function driveLifecycleNativeQueueLand(input: {
  pool: ConstructorParameters<typeof PgMergeQueueEventEmitter>[0];
  orgId: string;
  entry: MergeQueueEntry;
  queue: PgMergeQueueModel;
  repo: { owner: string; name: string };
  headBranch: string;
  headSha: string;
  ssh: CommandSubstrate;
  target: RunnerHandle;
}): Promise<void> {
  const { authority, binding, evaluation, writer } = await buildLifecycleCanonicalAuthority(input);
  const queueEvents = new PgMergeQueueEventEmitter(input.pool, writer);
  const batchEvents = new PgBatchMergeEventEmitter(input.pool, writer);
  const result = await driveMultiMemberPass({
    deps: {
      queue: input.queue,
      events: queueEvents,
      authorityEvaluator: {
        evaluate: async () => evaluation,
        landAuthorizedGroup: async (land) => {
          if (!(await land.confirmBeforeLand())) return { kind: "policy_held" };
          const outcome = await authority.land(land.evaluation.authorization);
          return outcome.kind === "landed" ? { kind: "landed", mainSha: outcome.mainSha } : { kind: "rederive" };
        },
      },
      escalator: {
        async escalate() {
          throw new Error("lifecycle canonical land must not escalate");
        },
      },
    },
    projectId: input.entry.projectId,
    batch: [input.entry],
    binding,
    integrationBranch: "tanren-local-batch-lifecycle",
    queueDepth: 1,
    emitPassed: (batch, integrationBranch) =>
      batchEvents.emitPassed({ projectId: input.entry.projectId, batch, integrationBranch }),
    async drive() {
      throw new Error("lifecycle canonical land must not fall back to per-run drive");
    },
  });
  if (result.mergedSpecId !== input.entry.specId) {
    throw new Error(`canonical lifecycle land did not complete for ${input.entry.specId}`);
  }
}
