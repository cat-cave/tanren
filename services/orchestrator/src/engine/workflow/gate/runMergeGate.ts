// NATIVE MERGE GATE (the no-Actions delivery model). The merge authority is the
// in-loop native gate, NOT a forge CI provider: before a run merges, Tanren runs
// the repo's `pre_merge` gate tiers over SSH on the PR head and reads the verdict
// from exit codes — the SAME runner+gate the loop already drives at per_iteration
// and pre_audit, only the lifecycle point (`when`) differs. There is no check-run
// poll: nothing external is read for the merge decision.
//
// The in-loop merge gate reuses the run's already-built gate closure (the runner
// + workspace are still live at the merge-decision point) with `when: "pre_merge"`,
// so no fresh allocation is needed. The returned `GateOutcome.passed` IS the merge
// decision: true ⇒ proceed, false ⇒ halt. The caller publishes the verdict to the
// forge (`publishGateVerdict`). The QUEUED re-gate at merge-drive time — when the
// original runner is gone — uses the fresh-runner block (engine/merge/freshRunnerGate).
import type { CiWhen } from "../../ci/index.js";
import type { GateOutcome } from "./runGateForWhen.js";

/**
 * The in-loop native merge gate. Runs the repo's `pre_merge` gate tiers on the
 * run's live runner via the already-resolved gate closure (the same closure the
 * writer loop calls at per_iteration / pre_audit) and returns the verdict. No
 * forge poll, no fresh allocation — the runner is still up when this is called
 * from the run loop's merge-decision point.
 */
export async function runNativeMergeGate(input: {
  runGate: (gate: { when: CiWhen; taskId?: string; headShaOverride?: string }) => Promise<GateOutcome>;
  taskId?: string;
  // COMMIT-BINDING (§5): the PUSHED PR head sha the `pre_merge` verdict must anchor on
  // (the cleaned ref, not the workspace HEAD). Absent ⇒ the gate resolves the workspace
  // HEAD itself (the fake-SSH unit path / a caller without a separate PR head).
  headShaOverride?: string;
}): Promise<GateOutcome> {
  return input.runGate({
    when: "pre_merge",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.headShaOverride === undefined ? {} : { headShaOverride: input.headShaOverride }),
  });
}
