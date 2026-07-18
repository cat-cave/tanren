// Single source of truth for parameterized run/spec/task lifecycle SQL used by
// both the direct writer and control-plane endpoints.
//
// This compatibility barrel preserves the public import surface while cohesive
// lifecycle groups live in sibling modules under the source-file line cap.

export {
  applyAppendSpecSteering,
  applyClearRunPercolationPending,
  applyMergeRunVerifiedAncestorSha,
  applySetRunAuthRef,
  applySetRunPercolationReexecId,
  applySetRunPrUrl,
  applySetRunSpeculativeBase,
  applySetRunStatus,
  applySetSpecMetadata,
  applySetSpecStatus,
  applySupersedeQueuedPlannerTask,
} from "./runStateLifecycleSql.runSpec.js";

export {
  applyInsertTask,
  applyUpdateTask,
  applyUpdateTaskWithEvent,
  terminalPairSchema,
  type UpdateTaskWithEventOutcome,
} from "./runStateLifecycleSql.tasks.js";

// Task #48 + audit-finding-#3 atomic seams live in `./runStateAtomicSql.ts`
// (the 500-line cap keeps this file lean; re-exported here so callers see one namespace).
export {
  applyFinalizeRunWithEvent,
  applyResumePausedRunAtomic,
  applyUpdateSpecWithEvent,
  resumePausedRunPairSchema,
  runPairSchema,
  specPairSchema,
} from "./runStateAtomicSql.js";
