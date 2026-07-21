import type { Pool } from "pg";
import { BatchMergeCoordinator } from "../../src/engine/merge/batchCoordinator.js";
import { settleDriveOutcome } from "../../src/engine/merge/batchCoordinatorSettle.js";
import { PgBatchMergeEventEmitter } from "../../src/engine/merge/batchCoordinatorPg.js";
import { PgSpecEscalator } from "../../src/engine/merge/coordinatorEscalate.js";
import { PgMergeQueueEventEmitter, PgMergeQueueModel } from "../../src/engine/merge/coordinatorPg.js";
import { driveOutcomeFromRecoverySettlement } from "../../src/engine/merge/driveConflictVerdict.js";
import { MergeCoordinatorSubscriber } from "../../src/engine/merge/subscriber.js";
import { MergeAmbiguousError } from "../../src/engine/providers/mergeOutcomeErrors.js";
import { allowExactBatchAuthority } from "../helpers/mq2BatchAuthority.js";
import { makeTestIntegrationGraphScheduler } from "../helpers/integrationGraphScheduler.js";

export type CoordinatorDeps = ConstructorParameters<typeof BatchMergeCoordinator>[0];
export type RecoveryWriter = NonNullable<CoordinatorDeps["recoverySettlement"]> &
  ConstructorParameters<typeof PgSpecEscalator>[1];

export function productionCoordinator(
  pool: Pool,
  writer: RecoveryWriter,
  checker: CoordinatorDeps["checker"],
  runner: CoordinatorDeps["runner"],
): BatchMergeCoordinator {
  const queue = new PgMergeQueueModel(pool);
  return new BatchMergeCoordinator({
    scheduler: makeTestIntegrationGraphScheduler(),
    authorityEvaluator: allowExactBatchAuthority(),
    queue,
    checker,
    runner,
    events: new PgMergeQueueEventEmitter(pool, writer),
    batchEvents: new PgBatchMergeEventEmitter(pool, writer),
    escalator: new PgSpecEscalator(pool, writer),
    recoverySettlement: writer,
    sleep: () => Promise.resolve(),
  });
}

export function throwAmbiguousMerge(message: string): never {
  throw new MergeAmbiguousError(message);
}

export async function redriveCredentialRepair(input: {
  pool: Pool;
  coordinator: BatchMergeCoordinator;
  writer: RecoveryWriter;
  eventId: string;
}): Promise<void> {
  const subscriber = new MergeCoordinatorSubscriber({
    pool: input.pool,
    notifyListener: {} as never,
    coordinator: input.coordinator,
    runStateWriter: input.writer,
    // This fixture verifies the merge repair path only; production wiring supplies
    // attemptDerivingActivation through autonomyLoops.
    attemptActivation: async () => {},
  });
  await (subscriber as unknown as { onEventActivity(eventId: string): Promise<void> }).onEventActivity(input.eventId);
}

export async function settleCompletedPark(
  pool: Pool,
  writer: RecoveryWriter,
  entry: Parameters<typeof settleDriveOutcome>[2],
  park: Extract<Awaited<ReturnType<RecoveryWriter["parkRecoveryAndDequeue"]>>, { kind: "parked" }>,
): Promise<"dequeued" | { retryAfterMs: number }> {
  return settleDriveOutcome(
    {
      queue: new PgMergeQueueModel(pool),
      events: new PgMergeQueueEventEmitter(pool, writer),
      escalator: new PgSpecEscalator(pool, writer),
      recoverySettlement: writer,
    },
    entry.projectId,
    entry,
    driveOutcomeFromRecoverySettlement(park, "parked by base-shift recovery"),
  );
}
