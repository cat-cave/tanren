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
// SELF-HEAL (apex v34): a failing `pre_merge` gate is almost always WRITER-FIXABLE (the
// writer's own scaffold/tests). It used to THROW here (the run failed `code:internal`, the
// spec STRANDED) even though the writer could fix it, while the FAST + SLOW tiers already
// self-heal back to the writer. Now the merge tier joins them: a failed `pre_merge` gate
// RE-ENTERS the writer loop with the failing tier/step/output as steering
// (`mergeGateRejection`), UNBOUNDED while it CONVERGES (the error changes OR its count shrinks)
// and halting LOUD only at a genuine fixed point (`mergeGateSelfHeal`). NO count.
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
import { NoCommitsBetweenBaseAndHeadError } from "../providers/githubPullRequestReuse.js";
import { appTokenSeam } from "./plannerRunSeams.js";
import { finalizeMergeOutcome, type FinalizeRunState } from "./plannerRunFinalize.js";
import { applyFailedMergeGate, mergeGateSelfHeal, type MergeGateBudget } from "./plannerRunSelfHeal.js";
import type { ReGateCiHook } from "./reviewMerge/index.js";
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
 * The branch being PR'd had NOTHING ahead of the base (GitHub's 422 "No commits between
 * base and head"). The PR-creation stage discriminates the two legitimate causes and routes
 * each WITHOUT a hard escalating `internal` failure (mirroring the empty-diff accept #586 at
 * the PR layer):
 *   - `converged`: the writer DID author a commit ahead of the clone base, but its content
 *     is already present in the base (the spec is satisfied by the base / a prior iteration
 *     landed) ⇒ the spec CONVERGES (merged/done), the same terminal-success the merge path
 *     takes, so the DAG advances + dependents unblock.
 *   - `redrive`: the cleaned PR head EQUALS the clone base (the writer produced no commit
 *     this attempt — a degraded/slow codex returned nothing) ⇒ a TRANSIENT re-drive.
 */
export type NoCommitsDisposition = "converged" | "redrive";

/**
 * The writer produced NO commit ahead of the base this attempt (the `redrive` branch of a
 * "No commits between base and head" 422). A TRANSIENT — classified `empty_writer_output`
 * (retriable), so the unified finalize RE-DRIVES it under the consecutive-same-failure cap
 * (after K it escalates LOUD as a GENUINE `persistent_failure` needs_attention, never a
 * silent stall / hot-loop), NOT a hard `internal` strand.
 */
export class EmptyWriterCommitError extends Error {
  constructor(branch: string, baseBranch: string) {
    super(`the writer produced no commit on ${branch} ahead of ${baseBranch} this attempt`);
    this.name = "EmptyWriterCommitError";
  }
}

/** The result of preparing + publishing the cleaned draft PR: a published PR, or a no-commits disposition. */
export type PublishCleanedDraftPrResult =
  | { kind: "published"; pushSource: CleanedPushSource; pullRequest: PublishedDraftPullRequest }
  | { kind: "no_commits"; pushSource: CleanedPushSource; disposition: NoCommitsDisposition };

type CleanedPushSource = Awaited<ReturnType<typeof prepareCleanPrBranch>>;

/**
 * Prepare the cleaned PR branch + publish the draft PR for one writer-loop pass. Replays
 * the writer commits onto the clone HEAD, dropping the synthetic bootstrap commit (+
 * install artifacts) so the pushed branch / PR carries only the writer's changes (the
 * working HEAD is left intact so a review/merge-gate-rework re-entry keeps its bootstrapSha
 * diff base — no-op on fake-SSH), then publishes the draft PR. Returns both the cleaned
 * push source (its `headSha` is the commit the `pre_merge` gate + land authority bind to,
 * §5) and the published PR.
 *
 * GRACEFUL EMPTY-BRANCH HANDLING (v35): when GitHub rejects the open with "No commits
 * between base and head" ({@link NoCommitsBetweenBaseAndHeadError}), the branch has NOTHING
 * ahead of the base — this is NOT a hard internal error. We DISCRIMINATE here using the
 * cleaned PR head vs the clone base (the rebase `--onto` target the PR diffs against): a
 * head EQUAL to the clone base means the writer produced no commit (`redrive` — transient),
 * and a head AHEAD of the base whose content GitHub still finds empty means the work is
 * already present in the base (`converged` — done). Extracted from the loop body to keep
 * plannerRun.ts under cap.
 */
export async function publishCleanedDraftPr(
  input: RunPlannerLoopInput,
  ctx: { target: RunnerHandle; workspacePath: string; eventStore: EventStore },
  context: PlannerRunContext,
  shas: { cloneHeadSha: string; bootstrapSha: string },
): Promise<PublishCleanedDraftPrResult> {
  const pushSource = await prepareCleanPrBranch({
    ssh: input.ssh,
    target: ctx.target,
    workspacePath: ctx.workspacePath,
    cloneHeadSha: shas.cloneHeadSha,
    bootstrapSha: shas.bootstrapSha,
  });
  try {
    // v68 fix: events.org_id NOT NULL on the table; stamp via the run's org_id
    // (NOT NULL on runs). Tests using FakeEventStore pass with an empty sentinel.
    const appendEventOrgId = typeof context.orgId === "string" ? context.orgId : "";
    const pullRequest = await publishDraftPullRequest({
      pool: input.pool,
      eventStore: ctx.eventStore,
      runStateWriter: input.runStateWriter,
      orgId: context.orgId,
      appendEventOrgId,
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
    });
    return { kind: "published", pushSource, pullRequest };
  } catch (error) {
    if (error instanceof NoCommitsBetweenBaseAndHeadError) {
      const disposition = discriminateNoCommits(pushSource.headSha, shas.cloneHeadSha);
      return { kind: "no_commits", pushSource, disposition };
    }
    throw error;
  }
}

/**
 * DISCRIMINATE a "No commits between base and head" 422 (the v35 graceful path). The cleaned
 * PR head is the writer's commits replayed onto the clone base (`cloneHeadSha`, the `--onto`
 * target the PR diffs against), with the bootstrap commit dropped:
 *   - head EQUAL to the clone base ⇒ the writer authored NO commit ahead of the base this
 *     attempt ⇒ `redrive` (a transient empty output; re-drive, never a hard strand).
 *   - head AHEAD of the base (a real writer commit) but GitHub finds the diff empty ⇒ the
 *     work is ALREADY PRESENT in the base ⇒ `converged` (the spec is satisfied → done).
 * On a fake-SSH unit path the head sha is "" (no real workspace) — treat as `redrive` (the
 * conservative transient), never a spurious converge.
 */
export function discriminateNoCommits(cleanedHeadSha: string, cloneHeadSha: string): NoCommitsDisposition {
  if (cleanedHeadSha === "" || cleanedHeadSha === cloneHeadSha) {
    return "redrive";
  }
  return "converged";
}

/**
 * Run the native `pre_merge` gate on the run's live runner (the merge authority) and
 * BEST-EFFORT publish the verdict to the forge as a `tanren/gate` commit status. A
 * passing gate RETURNS its `passed: true` outcome (the caller proceeds to merge); a failing
 * gate RETURNS its `passed: false` outcome (it does NOT throw) so the merge stage can route the
 * writer-fixable failure back to the writer to self-heal (the SELF-HEAL note above). A failed
 * forge PUBLISH of a passing verdict is NON-fatal: the publish is informational; the internal
 * verdict decides the merge.
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
  // A failing gate is NOT a throw: the merge stage inspects `outcome.passed` and routes a
  // failure back to the writer (self-heal). The verdict is fail-closed (`passed: false`) so
  // the run never merges an unverified head.
  return outcome;
}

/** The merge-gate STAGE result the planner loop maps: merge forward, re-author, halt, or no-commits. */
export type PublishGateStageResult =
  | {
      pullRequest: PublishedDraftPullRequest;
      mergeGate: GateOutcome;
      // `merged`: gate passed → proceed to review/merge. `rework`: writer-fixable fail, spec
      // returned to in_flight, re-enter the writer (caller `continue`s). `halt`: a fixed point,
      // run finalized + spec parked LOUD (caller returns the terminal result).
      kind: "merged" | "rework" | "halt";
    }
  // GRACEFUL EMPTY-BRANCH (v35): GitHub rejected the open with "No commits between base and
  // head" — the branch has NOTHING ahead of the base. NO PR was opened + NO gate ran. The stage
  // handled it WITHOUT a hard internal error: `converged_empty` means it ALREADY finalized the
  // run merged (work present in base — the spec is done) and the caller just returns the terminal
  // result; the writer-produced-nothing case is a transient the stage THROWS as
  // `EmptyWriterCommitError` (the unified finalize re-drives it, never escalating).
  | { kind: "converged_empty" };

/**
 * The merge-authority STAGE (apex v34): publish the cleaned draft PR, run the `pre_merge`
 * gate, and route its verdict. A PASSING gate ⇒ `merged`. A FAILING gate is WRITER-FIXABLE,
 * so — instead of the old `code:internal` throw+strand — apply the self-heal
 * (`mergeGateSelfHeal` + `applyFailedMergeGate`): `rework` (seed the failing tier/step/OUTPUT
 * as steering, re-enter the writer) while it CONVERGES, then `halt` (finalize halted + park
 * `needs_attention`, LOUD) at a fixed point. Owns the branching here so `runPlannerLoopWorkflow`
 * stays under the cyclomatic + line caps.
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
  const published = await publishCleanedDraftPr(input, ctx, context, {
    cloneHeadSha: stage.cloneHeadSha,
    bootstrapSha: stage.bootstrapSha,
  });
  if (published.kind === "no_commits") {
    // The branch had NOTHING ahead of the base: emit the OBSERVABLE disposition (never a
    // silent relabel), then converge (work already present) or re-drive (empty writer output)
    // — NEVER a hard internal strand. `converged` finalizes the run merged HERE (the spec is
    // satisfied by the base, same terminal-success a normal merge takes — mirrors #586) and
    // the caller returns; `redrive` THROWS the transient the unified finalize re-drives (#582;
    // `empty_writer_output`, escalating LOUD only after K), never an escalating `internal`.
    await stage.appendEvent("github.pr.no_commits", {
      branch: context.runBranch,
      targetBranch: context.targetBranch,
      disposition: published.disposition,
    });
    if (published.disposition === "redrive") {
      throw new EmptyWriterCommitError(context.runBranch, context.targetBranch);
    }
    await finalizeMergeOutcome(input, stage.finalizeRunState, context, stage.appendEvent, {
      outcome: "merged",
      integration: "direct_merge",
    });
    return { kind: "converged_empty" };
  }
  const { pushSource, pullRequest } = published;
  const mergeGate = await runMergeGateForRun(input, ctx, pushSource.headSha);
  if (mergeGate.passed) {
    return { pullRequest, mergeGate, kind: "merged" };
  }
  const decision = await mergeGateSelfHeal(mergeGate, stage.budget.attempts);
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
    // v68 fix: events.org_id is NOT NULL on the events row; AppendEventInput now
    // carries `orgId` explicitly. The run's org is propagated through PlannerRunContext;
    // when absent (a unit-path probe with no org context) skip the audit append
    // entirely — the publish failure is already logged above, and the row-without-org
    // would just be denied by RLS.
    const orgId = typeof context.orgId === "string" && context.orgId !== "" ? context.orgId : undefined;
    if (orgId === undefined) {
      log.warn("skipping gate.publish_failed audit append — context.orgId is unset", { runId: context.runId });
      return;
    }
    await ctx.eventStore
      .append({
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        orgId,
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
  // v68 fix: events.org_id is NOT NULL; AppendEventInput requires explicit `orgId`.
  // The publish only runs under a real run (token / installation gate already
  // returned above on null-org public-repo runs), and PlannerRunContext.orgId
  // propagates the run's org_id (NOT NULL). Narrow once + skip the audit append
  // on a missing org (defensive — the gate has no row to scope the event under).
  const auditOrgId = typeof context.orgId === "string" && context.orgId !== "" ? context.orgId : undefined;
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
      if (auditOrgId === undefined) {
        log.warn("skipping gate.publish_failed audit append — context.orgId is unset", { runId: context.runId });
        return;
      }
      await ctx.eventStore.append({
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        orgId: auditOrgId,
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
