// The pool-backed PORTS the run worker constructs from `deps.pool` and hands to
// `runPlannerLoopWorkflow` at the workflow call site. Co-located here so the worker
// (`runExecutor.ts`) takes ONE module edge for the whole set rather than one per port
// (keeping it under its module-dependency cap):
//
//   - `buildNativeQueueEnqueuer` — under `native_queue`, enters a ready run into the
//     native merge queue (re-exported from the merge coordinator build).
//   - `buildEagerBaseNodeUpsert` — WS-A PR-8 (walker-jj-local-integration-design.md §2.3):
//     OBSERVE-ONLY, the jj-local dependent bootstrap records its `eager_base` integration
//     node (the proof-reuse substrate) through an org-scoped UPSERT over the worker's pool.
//   - `buildBootstrapStackHeadShaWriteBack` — WS-A PR-8c (same §2.3): the jj-local
//     dependent bootstrap folds the assembly-captured per-ancestor head shas BACK into
//     `runs.ancestor_stack[].headSha` through an org-scoped UPDATE over the worker's pool,
//     so percolation's divergence key reads the shas from `ancestor_stack`.
//
// All are thin org-scoped writers built over the worker's REAL pool, so the writes land
// RLS-scoped (not on the org-scoping workflow proxy).

export { buildNativeQueueEnqueuer } from "../merge/coordinatorBuild.js";
// Audit finding D3/H3 sweep: the workflow's writer-seam helper in `runExecutor.ts`
// rebuilds the Direct writer over `orgScopingPool` so in-process events carry the
// per-job org GUC. Re-exported here so `runExecutor.ts` reaches the class via
// its existing port import (file-dependency cap).
export { DirectRunStateWriter } from "./directRunStateWriter.js";
export {
  buildAncestorPhaseReader,
  buildBootstrapStackHeadShaWriteBack,
  buildEagerBaseNodeUpsert,
} from "../workflow/plannerRunJjLocalBootstrap.js";
// apex v35 ROBUSTNESS: the consecutive-same-failure reader the run-failure boundary uses to
// decide RE-DRIVE (a random/transient fault) vs ESCALATE (the SAME failure K times). An
// org-scoped read of the spec's prior `dag.spec.redriven` events over the worker's real pool.
export { buildRedriveHistoryReader } from "../workflow/plannerRunRedrive.js";
