// The planner-loop's NATIVE MERGE-GATE tail, split out of plannerRun.ts to keep
// that file under the 500-line architecture cap (the no-Actions delivery model).
//
// The merge authority is the in-loop native gate, NOT a forge CI poll. At the
// merge-decision point the run's runner + workspace are still live, so
// `runMergeGateForRun` reuses the run's already-built gate closure with
// `when: "pre_merge"` and publishes the verdict to the forge as a `tanren/gate`
// commit status (`publishGateVerdict`). A passing gate proceeds to merge; a failing one
// throws (the loop halts) — exactly as the old CI poll did, but the verdict comes
// from Tanren's own gate over SSH, never from reading GitHub Actions.
//
// The forge publication is BEST-EFFORT: it only mirrors the (already-decided) verdict
// onto the PR, so a publish failure (e.g. a token credential 403, a transient 5xx) is
// caught, recorded as a `gate.publish_failed` warning, and the run PROCEEDS to merge on
// the internal verdict. The gate verdict — not the forge publish — is the authority.
//
// `buildReGateCi` is the merge stage's re-gate hook (after an auto-rebase advances
// the branch, the prior verdict is stale). At that point the run's original runner
// is still up (the merge stage runs before the runner is released), so the re-gate
// reuses the same in-loop gate closure on a re-pulled head. A passing re-gate is
// `passed`, a throw is `failed` — the merge stage never merges an unverified rebase.

import type { RunnerHandle } from "../contracts/allocator.js";
import { resolveWorkspaceHeadSha } from "../workspace/index.js";
import { type CiWhen } from "../ci/index.js";
import { type GateOutcome, publishGateVerdictBestEffort, runNativeMergeGate } from "./gate/index.js";
import type { EventStore } from "../eventStore.js";
import type { ReGateCiHook } from "./reviewMerge/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("gate");

/** The live-runner context the in-loop merge gate runs + publishes against. */
export interface MergeGateRunContext {
  // The run's gate closure. `headShaOverride` anchors the `pre_merge` `gate.verdict`
  // on the PUSHED PR head (the cleaned ref) instead of the workspace HEAD — the
  // gate↔land commit-binding (§5). Optional: per_iteration / pre_audit omit it.
  runGate: (gate: { when: CiWhen; taskId?: string; headShaOverride?: string }) => Promise<GateOutcome>;
  target: RunnerHandle;
  workspacePath: string;
  eventStore: EventStore;
}

/**
 * Run the native `pre_merge` gate on the run's live runner (the merge authority) and
 * BEST-EFFORT publish the verdict to the forge as a `tanren/gate` commit status. A
 * passing gate RETURNS its outcome (the caller proceeds to merge); a failing gate
 * THROWS so the loop halts without merging — the same control flow the retired CI poll
 * had. A failed forge PUBLISH of a passing verdict is NON-fatal (it never aborts the
 * run): the publish is informational; the internal verdict decides the merge.
 */
export async function runMergeGateForRun(
  input: RunPlannerLoopInput,
  ctx: MergeGateRunContext,
  prHeadSha: string,
): Promise<GateOutcome> {
  // COMMIT-BINDING (§5): anchor the `pre_merge` verdict on the PUSHED PR head (the
  // cleaned ref) — the commit the land authority resolves from the forge — NOT the
  // workspace HEAD (left at the writer tip with the dropped bootstrap commit). Without
  // this the recorded `gatedHeadSha` never equals the landing head and the authority
  // blocks forever. "" only on a fake-SSH unit path ⇒ the gate falls back to the
  // workspace HEAD (also "" there ⇒ no verdict event), behavior-unchanged for tests.
  const outcome = await runNativeMergeGate({
    runGate: ctx.runGate,
    ...(prHeadSha !== "" && { headShaOverride: prHeadSha }),
  });
  await publishMergeVerdict(input, ctx, outcome, prHeadSha);
  if (!outcome.passed) {
    throw new Error(`planner-loop native gate failed: tier ${outcome.failure.tier} step ${outcome.failure.failedStep}`);
  }
  return outcome;
}

/**
 * BEST-EFFORT publish the native gate verdict to the forge against the just-gated
 * workspace HEAD. Resolves the head sha + an App-first/static token through the SAME
 * seams the PR / merge stages use. A genuinely unauthenticated public-repo run (no
 * installation, no static ref) skips publication (it has no token to publish with).
 * A publish failure (403/404/5xx/network) is caught + recorded as a non-fatal
 * `gate.publish_failed` warning; it NEVER aborts the run, which merges on the
 * internal verdict regardless of whether the forge mirror succeeded.
 */
async function publishMergeVerdict(
  input: RunPlannerLoopInput,
  ctx: MergeGateRunContext,
  outcome: GateOutcome,
  prHeadSha?: string,
): Promise<void> {
  // §3.8 INTERNALLY NON-THROWING: this publish is documented BEST-EFFORT — it only
  // mirrors an ALREADY-DECIDED verdict onto the PR. The PREP (head-sha resolve + token
  // mint) can throw on a transient Vault/mint failure; without this guard that throw
  // propagates out of `runMergeGateForRun` and FAILS a run whose gate PASSED (a terminal
  // `merge.failed` on the resolved-tree path). The `publishGateVerdictBestEffort` body
  // already swallows publish-time failures; this catch extends that to the prep so the
  // WHOLE publish is non-fatal. The run always merges on the internal verdict.
  try {
    await doPublishMergeVerdict(input, ctx, outcome, prHeadSha);
  } catch (error) {
    const context = input.context;
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("forge verdict publish PREP failed (non-fatal; merging on internal verdict)", {
      runId: context.runId,
      reason,
    });
    await ctx.eventStore
      .append({
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        eventType: "gate.publish_failed",
        payload: { when: "pre_merge", headSha: prHeadSha ?? "", passed: outcome.passed, reason },
      })
      // Even the audit append is best-effort here — a publish-prep failure must NEVER fail
      // a passed run, so a failure to record the warning is logged + swallowed.
      .catch((appendError: unknown) => {
        log.warn("failed to record gate.publish_failed", { runId: context.runId }, appendError);
      });
  }
}

/** The head-sha resolve + token mint + best-effort publish; wrapped non-throwing by {@link publishMergeVerdict}. */
async function doPublishMergeVerdict(
  input: RunPlannerLoopInput,
  ctx: MergeGateRunContext,
  outcome: GateOutcome,
  prHeadSha?: string,
): Promise<void> {
  const context = input.context;
  const staticRef = context.githubCredentialRef;
  // A genuinely unauthenticated public-repo run has no token to publish with → skip.
  if (context.installation === undefined && staticRef.trim() === "") {
    return;
  }
  // COMMIT-BINDING: publish the forge commit status on the SAME sha the verdict was
  // recorded for — the PUSHED PR head when known (the initial merge gate), falling back
  // to the workspace HEAD (the re-gate path, where the local workspace IS the head). A
  // mismatched status sha would mirror the verdict onto the wrong commit on the PR.
  const headSha =
    prHeadSha !== undefined && prHeadSha !== ""
      ? prHeadSha
      : await resolveWorkspaceHeadSha({
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
  await publishGateVerdictBestEffort(
    {
      vcsProvider: input.vcsProvider,
      repo: input.vcsProvider.parseRepository(context.repoUrl),
      token,
      headSha,
      outcome,
    },
    "pre_merge",
    outcome.passed,
    async ({ when, headSha: sha, passed, reason }) => {
      log.warn("forge verdict publish failed (non-fatal; merging on internal verdict)", {
        runId: context.runId,
        reason,
      });
      await ctx.eventStore.append({
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        eventType: "gate.publish_failed",
        payload: { when, headSha: sha, passed, reason },
      });
    },
  );
}

/**
 * Build the merge stage's native re-gate hook. After an auto-rebase the prior
 * verdict is stale, so re-run the in-loop `pre_merge` gate on the run's live runner
 * and re-publish the verdict (the head sha changed). A passing re-gate is `passed`;
 * a throw is `failed`, so the merge stage never merges an unverified rebase.
 *
 * COMMIT-BINDING (§5): the BEHIND re-gate passes the EXACT rebased PR-head sha
 * (`rebasedHeadSha`) so the re-gate's `pre_merge` verdict is anchored on the commit
 * the authority lands — the forge-side rebase did NOT necessarily advance the local
 * workspace HEAD, so binding to the workspace HEAD there is unproven. Absent (the
 * resolved-tree re-gate, where the local workspace IS the resolved head) ⇒ the gate
 * binds to the workspace HEAD. A bad/absent override on the pre_merge path is a
 * FAIL-CLOSED throw in `buildDefaultGate` (→ `status: "failed"`), never a silent
 * wrong-commit bind.
 */
export function buildReGateCi(input: RunPlannerLoopInput, ctx: MergeGateRunContext): ReGateCiHook {
  return async (hook) => {
    const rebasedHeadSha = hook?.rebasedHeadSha;
    try {
      const outcome = await runNativeMergeGate({
        runGate: ctx.runGate,
        ...(rebasedHeadSha !== undefined && rebasedHeadSha !== "" && { headShaOverride: rebasedHeadSha }),
      });
      await publishMergeVerdict(input, ctx, outcome, rebasedHeadSha);
      return { status: outcome.passed ? "passed" : "failed" };
    } catch (error) {
      // FAIL-CLOSED: a re-gate throw blocks the merge (the rebased head is
      // unverified). Keep the failed verdict, but log the swallowed error LOUD
      // first — never discard it silently (no_silent_fallbacks).
      log.error(
        "merge re-gate failed (fail-closed; merge blocked on unverified rebase)",
        {
          runId: input.context.runId,
          ...(rebasedHeadSha !== undefined && { rebasedHeadSha }),
        },
        error,
      );
      return { status: "failed" };
    }
  };
}
