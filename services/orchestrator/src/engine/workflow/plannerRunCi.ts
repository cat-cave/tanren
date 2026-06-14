// The planner-loop's NATIVE MERGE-GATE tail, split out of plannerRun.ts to keep
// that file under the 500-line architecture cap (the no-Actions delivery model).
//
// The merge authority is the in-loop native gate, NOT a forge CI poll. At the
// merge-decision point the run's runner + workspace are still live, so
// `runMergeGateForRun` reuses the run's already-built gate closure with
// `when: "pre_merge"` and publishes the verdict to the forge as a `tanren/gate`
// commit status (`publishGateVerdict`). A passing gate proceeds to merge; a failing one
// RETURNS its failed `GateOutcome` (it does NOT throw) — the verdict comes from
// Tanren's own gate over SSH, never from reading GitHub Actions.
//
// SELF-HEAL (apex v34): a failing `pre_merge` gate is almost always WRITER-FIXABLE —
// the writer's own scaffold/tests (e.g. a `merge`-tier `tier-3` of cucumber+stryker
// that exits 1). It used to THROW here → the run failed `code:internal` and the spec
// terminally STRANDED, even though the writer could fix it. That stranded a
// writer-fixable failure while the FAST tier (per_iteration) and the SLOW tier
// (pre_audit) both already self-heal back to the writer (the fast tier loops straight
// back; the slow tier becomes a P0 finding → triage → writer). Now the merge tier
// joins them: a failed `pre_merge` gate is RETURNED to the merge stage, which re-enters
// the writer loop with the failing tier/step/output as planner steering
// (`mergeGateRejection`, mirroring the review-rework re-entry), BOUNDED by a dedicated
// rework budget so a spec the writer genuinely cannot make merge-ready halts LOUD
// (`needs_attention`) rather than looping forever or stranding on the first failure.
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
import { prepareCleanPrBranch } from "../workspace/githubPush.js";
import { type CiWhen } from "../ci/index.js";
import { type GateOutcome, publishGateVerdictBestEffort, runNativeMergeGate } from "./gate/index.js";
import { buildProjectHostSeams } from "../providers/hostFactory.js";
import { parseGitHubRepository } from "../providers/github.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import type { EventStore } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import { publishDraftPullRequest, type PublishedDraftPullRequest } from "./githubDraftPr.js";
import { appTokenSeam, writerSeam } from "./plannerRunSeams.js";
import { applyFailedMergeGate, type FinalizeRunState, type MergeGateBudget } from "./plannerRunFinalize.js";
import { mergeGateRejection, type ReGateCiHook } from "./reviewMerge/index.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
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
 * Prepare the cleaned PR branch + publish the draft PR for one writer-loop pass. Replays
 * the writer commits onto the clone HEAD, dropping the synthetic bootstrap commit (+
 * install artifacts) so the pushed branch / PR carries only the writer's changes (the
 * working HEAD is left intact so a review/merge-gate-rework re-entry keeps its bootstrapSha
 * diff base — no-op on fake-SSH), then publishes the draft PR. Returns both the cleaned
 * push source (its `headSha` is the commit the `pre_merge` gate + land authority bind to,
 * §5) and the published PR. Extracted from the loop body to keep plannerRun.ts under cap.
 */
export async function publishCleanedDraftPr(
  input: RunPlannerLoopInput,
  ctx: { target: RunnerHandle; workspacePath: string; eventStore: EventStore },
  context: PlannerRunContext,
  shas: { cloneHeadSha: string; bootstrapSha: string },
): Promise<{ pushSource: Awaited<ReturnType<typeof prepareCleanPrBranch>>; pullRequest: PublishedDraftPullRequest }> {
  const pushSource = await prepareCleanPrBranch({
    ssh: input.ssh,
    target: ctx.target,
    workspacePath: ctx.workspacePath,
    cloneHeadSha: shas.cloneHeadSha,
    bootstrapSha: shas.bootstrapSha,
    timeoutMs: input.timeoutMs,
  });
  const pullRequest = await publishDraftPullRequest({
    pool: input.pool,
    eventStore: ctx.eventStore,
    ...writerSeam(input),
    orgId: context.orgId,
    secrets: input.secrets,
    githubHttp: input.githubHttp,
    ssh: input.ssh,
    target: ctx.target,
    sourceRef: pushSource.ref,
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    workspacePath: ctx.workspacePath,
    repoUrl: context.repoUrl,
    targetBranch: context.targetBranch,
    // WS-A PR-5 (§3.1): the ancestor stack so the draft PR bases on the immediate
    // ancestor's PR-head branch (flag-gated stacked PR); flag-off ⇒ `targetBranch`.
    ...(context.ancestorStack !== undefined && { ancestorStack: context.ancestorStack }),
    runBranch: context.runBranch,
    title: `Tanren: ${context.specTitle}`,
    body: context.specDescription,
    githubCredentialRef: context.githubCredentialRef,
    ...appTokenSeam(context, input),
    timeoutMs: input.timeoutMs,
  });
  return { pushSource, pullRequest };
}

/**
 * Run the native `pre_merge` gate on the run's live runner (the merge authority) and
 * BEST-EFFORT publish the verdict to the forge as a `tanren/gate` commit status. A
 * passing gate RETURNS its `passed: true` outcome (the caller proceeds to merge); a
 * failing gate RETURNS its `passed: false` outcome (it does NOT throw) so the merge
 * stage can route the writer-fixable failure back to the writer to self-heal (the
 * SELF-HEAL note above), BOUNDED by the merge-gate rework budget. A failed forge
 * PUBLISH of a passing verdict is NON-fatal (it never aborts the run): the publish is
 * informational; the internal verdict decides the merge.
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
  // A failing gate is NOT a throw: the merge stage inspects `outcome.passed` and routes
  // a failure back to the writer (self-heal), bounded by the rework budget. The verdict
  // is fail-closed (`passed: false`) so the run never merges an unverified head.
  return outcome;
}

/** The merge stage's bounded decision for a failed `pre_merge` gate: re-author or halt. */
export type MergeGateSelfHealDecision =
  // Re-enter the writer loop, seeding the carried rejection (the failing tier/step/output
  // as planner steering). Budget is not yet exhausted.
  | { kind: "rework"; rejection: PlannerRejectionFeedback }
  // Budget exhausted: the writer could not make the merge gate pass — halt LOUD.
  | { kind: "halt" };

/**
 * SELF-HEAL (apex v34): decide what a FAILED `pre_merge` ("merge"-tier) gate does, bounded
 * by the merge-gate rework budget. While the budget has room, return a `rework` decision
 * carrying the `mergeGateRejection` steering (the failing tier/step + the failed step's
 * captured OUTPUT) so the merge stage re-enters the writer loop to self-heal — mirroring
 * the review-rework re-entry, NOT the old `code:internal` throw+strand. Once the budget is
 * spent, return `halt` so the run ends LOUD (`needs_attention`) instead of looping forever.
 * Kept here (not inline in plannerRun.ts) so that file stays under the 500-line cap.
 */
export function mergeGateSelfHeal(
  gate: Extract<GateOutcome, { passed: false }>,
  reworksUsed: number,
  maxReworks: number,
): MergeGateSelfHealDecision {
  if (reworksUsed >= maxReworks) {
    return { kind: "halt" };
  }
  return { kind: "rework", rejection: mergeGateRejection(gate) };
}

/** The merge-gate STAGE result the planner loop maps: merge forward, re-author, or halt. */
export type PublishGateStageResult = {
  pullRequest: PublishedDraftPullRequest;
  mergeGate: GateOutcome;
  // `merged`: gate passed → proceed to review/merge. `rework`: writer-fixable fail, spec
  // returned to in_flight, re-enter the writer (caller `continue`s). `halt`: budget spent,
  // run finalized + spec parked LOUD (caller returns the terminal result).
  kind: "merged" | "rework" | "halt";
};

/**
 * The merge-authority STAGE (apex v34): publish the cleaned draft PR, run the `pre_merge`
 * gate, and route its verdict. A PASSING gate ⇒ `merged` (proceed to review/merge). A
 * FAILING gate is WRITER-FIXABLE (the writer's own scaffold/tests), so — instead of the old
 * `code:internal` throw+strand — apply the BOUNDED self-heal (`mergeGateSelfHeal` +
 * `applyFailedMergeGate`): `rework` (seed the failing tier/step/OUTPUT as steering, return
 * the spec to in_flight, re-enter the writer) until the budget is spent, then `halt`
 * (finalize the run halted + park the spec `needs_attention`, LOUD). Owns the stage's
 * branching here so `runPlannerLoopWorkflow` stays under the cyclomatic + line caps.
 */
export async function runPublishGateStage(
  input: RunPlannerLoopInput,
  ctx: MergeGateRunContext,
  context: PlannerRunContext,
  stage: {
    cloneHeadSha: string;
    bootstrapSha: string;
    finalizeRunState: FinalizeRunState;
    appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
    seedRejections: PlannerRejectionFeedback[];
    budget: MergeGateBudget;
  },
): Promise<PublishGateStageResult> {
  const { pushSource, pullRequest } = await publishCleanedDraftPr(input, ctx, context, {
    cloneHeadSha: stage.cloneHeadSha,
    bootstrapSha: stage.bootstrapSha,
  });
  const mergeGate = await runMergeGateForRun(input, ctx, pushSource.headSha);
  if (mergeGate.passed) {
    return { pullRequest, mergeGate, kind: "merged" };
  }
  const decision = mergeGateSelfHeal(mergeGate, stage.budget.used, stage.budget.max);
  const move = await applyFailedMergeGate(
    input,
    stage.finalizeRunState,
    context,
    stage.appendEvent,
    decision,
    stage.seedRejections,
    stage.budget,
  );
  return { pullRequest, mergeGate, kind: move };
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
  const token = await resolveVcsToken(input.githubHttp, {
    secrets: input.secrets,
    ...(context.installation !== undefined && { installation: context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  const repo = parseGitHubRepository(context.repoUrl);
  const { visibility } = buildProjectHostSeams(input.githubHttp, async () => token);
  await publishGateVerdictBestEffort(
    {
      visibility,
      repoFullName: `${repo.owner}/${repo.name}`,
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
