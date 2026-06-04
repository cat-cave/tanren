// The planner-loop's NATIVE MERGE-GATE tail, split out of plannerRun.ts to keep
// that file under the 500-line architecture cap (the no-Actions delivery model).
//
// The merge authority is the in-loop native gate, NOT a forge CI poll. At the
// merge-decision point the run's runner + workspace are still live, so
// `runMergeGateForRun` reuses the run's already-built gate closure with
// `when: "pre_merge"` and publishes the verdict to the forge as a `tanren/gate`
// check-run (`publishGateVerdict`). A passing gate proceeds to merge; a failing one
// throws (the loop halts) — exactly as the old CI poll did, but the verdict comes
// from Tanren's own gate over SSH, never from reading GitHub Actions.
//
// `buildReGateCi` is the merge stage's re-gate hook (after an auto-rebase advances
// the branch, the prior verdict is stale). At that point the run's original runner
// is still up (the merge stage runs before the runner is released), so the re-gate
// reuses the same in-loop gate closure on a re-pulled head. A passing re-gate is
// `passed`, a throw is `failed` — the merge stage never merges an unverified rebase.

import type { SshTarget } from "../contracts/allocator.js";
import { resolveWorkspaceHeadSha } from "../workspace/index.js";
import { type CiWhen } from "../ci/index.js";
import { type GateOutcome, publishGateVerdict, runNativeMergeGate } from "./gate/index.js";
import type { EventStore } from "../eventStore.js";
import type { ReGateCiHook } from "./reviewMerge/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

/** The live-runner context the in-loop merge gate runs + publishes against. */
export interface MergeGateRunContext {
  runGate: (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  target: SshTarget;
  workspacePath: string;
  eventStore: EventStore;
}

/**
 * Run the native `pre_merge` gate on the run's live runner (the merge authority) and
 * publish the verdict to the forge as a `tanren/gate` check-run. A passing gate
 * RETURNS its outcome (the caller proceeds to merge); a failing gate THROWS so the
 * loop halts without merging — the same control flow the retired CI poll had.
 */
export async function runMergeGateForRun(input: RunPlannerLoopInput, ctx: MergeGateRunContext): Promise<GateOutcome> {
  const outcome = await runNativeMergeGate({ runGate: ctx.runGate });
  await publishMergeVerdict(input, ctx, outcome);
  if (!outcome.passed) {
    throw new Error(`planner-loop native gate failed: tier ${outcome.failure.tier} step ${outcome.failure.failedStep}`);
  }
  return outcome;
}

/**
 * Publish the native gate verdict to the forge against the just-gated workspace HEAD.
 * Resolves the head sha + an App-first/static token through the SAME seams the PR /
 * merge stages use. A genuinely unauthenticated public-repo run (no installation, no
 * static ref) skips publication (it has no token to publish with).
 */
async function publishMergeVerdict(
  input: RunPlannerLoopInput,
  ctx: MergeGateRunContext,
  outcome: GateOutcome,
): Promise<void> {
  const context = input.context;
  const staticRef = context.githubCredentialRef;
  // A genuinely unauthenticated public-repo run has no token to publish with → skip.
  if (context.installation === undefined && staticRef.trim() === "") {
    return;
  }
  const headSha = await resolveWorkspaceHeadSha({
    ssh: input.ssh,
    target: ctx.target,
    workspacePath: ctx.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  if (headSha === "") {
    return;
  }
  const token = await input.vcsProvider.resolveToken({
    secrets: input.secrets,
    ...(context.installation !== undefined && { installation: context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  await publishGateVerdict({
    vcsProvider: input.vcsProvider,
    repo: input.vcsProvider.parseRepository(context.repoUrl),
    token,
    headSha,
    outcome,
  });
}

/**
 * Build the merge stage's native re-gate hook. After an auto-rebase the prior
 * verdict is stale, so re-run the in-loop `pre_merge` gate on the run's live runner
 * and re-publish the verdict (the head sha changed). A passing re-gate is `passed`;
 * a throw is `failed`, so the merge stage never merges an unverified rebase.
 */
export function buildReGateCi(input: RunPlannerLoopInput, ctx: MergeGateRunContext): ReGateCiHook {
  return async () => {
    try {
      const outcome = await runNativeMergeGate({ runGate: ctx.runGate });
      await publishMergeVerdict(input, ctx, outcome);
      return { status: outcome.passed ? "passed" : "failed" };
    } catch {
      return { status: "failed" };
    }
  };
}
