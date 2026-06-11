// the merge stage. Runs after the review stage returns `approved`.
// Dispatches to one of the per-repo MergeIntegration modes selected from the
// project config:
//
//   direct_merge      → GitHub merge API (PUT /pulls/:n/merge)
//   native_queue      → enter Tanren's native merge queue; the coordinator
//                       later DRIVES the merge through the same per-run path
//   external_reviewer → stop at ready-for-review; emit a hand-off and let a
//                       human merge (no merge call is made here)
//   not_configured    → treated as an external_reviewer hand-off (safe default;
//                       never auto-merge a repo that has not opted in)
//
// A direct merge that GitHub reports as non-mergeable (405/409) is surfaced as
// `merge.conflict` + a typed recoverable outcome — the hook the future
// conflict-resolver attaches to. Required checks are never bypassed: a
// branch-protected PR returns 405 and is reported as not-merged, not forced.
//
// up-to-date enforcement: BEFORE the direct merge, the stage reads the PR
// branch's mergeability (`readMergeability`). A `behind` branch is auto-rebased
// via the server-side update-branch API (`updateBranch`) and its CI is re-polled
// to green (`reGateCi`) before merging — emitting `merge.behind` + `merge.rebased`
// for visibility. A `dirty` branch (or a 422 from update-branch) is routed to the
// conflict-resolver hook + the recoverable `merge.conflict` outcome, NOT merged.
// So a stale/conflicting branch is DETECTED and routed, not discovered as a raw
// 405/409 at merge time.

import type { MergeIntegration } from "../../config/shared.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { applySpeculativeRetarget, resolveSpeculativeState } from "./speculativeStackRetarget.js";
import { ensureSystemTask, routeTaskUpdate } from "../taskWriteRouting.js";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import type { PullRequestRef, RepoRef } from "../../contracts/vcsProvider.js";
import { buildBundleForMergeStage } from "../../merge/mergeAuthorityBundleBuild.js";
import {
  contextOptionsFor,
  loadReviewMergeRunContext,
  type ReviewMergeRunContext,
  type RunStateClient,
} from "./context.js";
import {
  assessExternalChange,
  decidePosture,
  tanrenIdentity,
  type ContributorProbe,
  type PostureDecision,
  type PullRequestContributors,
} from "./governancePosture.js";
import { MergeDispatcher } from "./mergeDispatcher.js";
import {
  type ConflictContext,
  type ConflictResolverHook,
  type DispatchedIntegration,
  type MergeAuthorityBundle,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
  type NativeQueueEnqueuer,
  type ReGateCiHook,
} from "./mergeDispatchTypes.js";

// Re-export the merge-stage contracts so the barrel + existing import sites keep
// pulling them from `mergeDispatch.ts` after the type extraction.
export {
  type ConflictContext,
  type ConflictResolverHook,
  type DispatchedIntegration,
  type MergeAuthorityBundle,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
  type NativeQueueEnqueuer,
  type ReGateCiHook,
};

/** Map the configured integration to the mode the stage dispatches to. */
export function dispatchedIntegrationFor(mode: MergeIntegration): DispatchedIntegration {
  if (mode === "direct_merge" || mode === "native_queue" || mode === "external_reviewer") {
    return mode;
  }
  // not_configured → never auto-merge; hand off to a human.
  return "external_reviewer";
}

export async function mergeForRun(input: MergeForRunInput): Promise<MergeForRunResult> {
  const context = await loadReviewMergeRunContext(input.pool, input.runId, contextOptionsFor(input));
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const prRef = input.vcsProvider.parsePullRequest(context.prUrl);
  const pr = { repo: prRef.repo, pullNumber: prRef.number };
  const integration = dispatchedIntegrationFor(context.mergeIntegration);
  const taskId = await ensureMergeTask(input.pool, context, input.runStateWriter);
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "merge" },
  });

  // §2c/§2.3: resolve the run's speculative state. A NORMAL run (empty `ancestor_stack`) is
  // undefined and proceeds unchanged. A SPECULATIVE run's PR is stacked on its immediate
  // unmerged ancestor's PR-head branch; its merge HOLDS until every ancestor lands, then the
  // stack walk retargets it onto real `default_branch`.
  const speculative = await resolveSpeculativeState(input.pool, context.runId);

  const probe = input.mergeProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));

  const speculativeHold = speculative !== undefined && speculative.unmergedAncestors.length > 0;
  if (speculative !== undefined) {
    // §3.2/§3.3: re-target the PR base — the stacked-PR WALK (the base tracks the immediate
    // still-unmerged ancestor + drops merged heads from `ancestor_stack`, landing on
    // `default_branch` once the stack empties). The MERGE HOLD is UNCHANGED and handled
    // below; this only walks the BASE.
    await applySpeculativeRetarget({
      pool: input.pool,
      eventStore,
      context,
      taskId,
      integration,
      prNumber: pr.pullNumber,
      probe,
      speculative,
    });
    // (a) HOLD while any ancestor is still unmerged — no unreviewed ancestor code
    // reaches `main` early. The DagWalker re-walks on the ancestor merge.completed,
    // re-entering this stage once the ancestors land.
    if (speculativeHold) {
      await eventStore.append({
        runId: context.runId,
        specId: context.specId,
        projectId: context.projectId,
        taskId,
        eventType: "merge.speculative_held",
        payload: {
          prUrl: context.prUrl,
          prNumber: pr.pullNumber,
          integration,
          // jj-local: the held PR stacks on its immediate unmerged ancestor's PR-head branch
          // (the LAST stack entry), or `default_branch` once the stack empties. No host ref.
          speculativeBase: speculative.ancestorStack.at(-1)?.branch || context.baseBranch,
          unmergedAncestors: speculative.unmergedAncestors,
        },
      });
      if (integration !== "native_queue" || input.queueDrive === true) {
        await completeHeldMergeTask(input.pool, eventStore, context, taskId, integration, input.runStateWriter);
        return {
          runId: context.runId,
          taskId,
          integration,
          outcome: "blocked",
          prUrl: context.prUrl,
          prNumber: pr.pullNumber,
          message: `merge held: ancestors not yet merged (${speculative.unmergedAncestors.join(", ")})`,
        };
      }
    }
  }

  // §5 cutover: when this pass WILL drive the land (direct_merge, or the
  // native_queue coordinator DRIVE pass), provide a `buildMergeAuthority` thunk. The
  // dispatcher invokes it ONLY when a land is actually authorized (inside
  // `landViaAuthority`, after `ensureUpToDate` proceeds) — so a branch that
  // conflicts/holds first never pays the bundle's DB reads + CodeHost build. The thunk
  // gathers the run context + gate/review signals + the resolved CodeHost, then runs the
  // guaranteed truth table — the SOLE, unconditional land authority. A test/out-of-band
  // caller may pre-supply `input.mergeAuthority` directly instead.
  const willDriveLand = integration === "direct_merge" || (integration === "native_queue" && input.queueDrive === true);
  const mergeInput: MergeForRunInput =
    input.mergeAuthority === undefined && willDriveLand
      ? { ...input, buildMergeAuthority: () => buildBundleForMergeStage(input, context) }
      : input;

  const dispatcher = new MergeDispatcher({
    input: mergeInput,
    context,
    eventStore,
    taskId,
    integration,
    pr,
    probe,
    // jj-local: there is NO synthesized integration ref to clean after merge (the dependent
    // assembled its base LOCALLY + stacked on real PR-head branches), so `speculativeCleanup`
    // is never set. `cleanupIntegrationBranch` (kept for PR-11) is a no-op without it.
  });

  // governance posture gate. Only Tanren-initiated auto-merges
  // (direct_merge / native_queue) are governed: a strict-posture external
  // change blocks (operator approval required); an audit_only external change
  // is observed (no merge call). The external_reviewer / not_configured
  // hand-off is already a human-merge path — Tanren is not auto-merging, so
  // there is nothing for the posture to block and the gate is skipped.
  if (integration !== "external_reviewer") {
    const decision = await evaluatePosture(input, context, pr.repo, pr.pullNumber, integration);
    if (decision.kind !== "proceed") {
      return dispatcher.blockByPosture(decision);
    }
  }

  if (integration === "external_reviewer") {
    return dispatcher.handOff();
  }
  if (integration === "native_queue" && input.queueDrive !== true) {
    // the run-loop's first pass under `native_queue` ENTERS the queue instead
    // of merging. The native MergeCoordinator later drives the actual merge (a
    // second mergeForRun call with `queueDrive: true` → the directMerge path
    // below). A speculative dependent whose hold has NOT cleared still enters
    // the queue; the queue's DAG ordering holds it until ancestors genuinely
    // merge, avoiding a false terminal run state.
    return dispatcher.enqueueNative();
  }
  // `direct_merge`, OR `native_queue` on the coordinator DRIVE pass: the SAME
  // per-run merge path (up-to-date/rebase + conflict-resolution + retarget
  // retarget). The dispatcher labels its events from `this.deps.integration`, so a
  // drive pass records `native_queue` — not a second merge implementation.
  return dispatcher.directMerge();
}

/**
 * Resolve the PR contributors and run the posture gate against them. The `open`
 * posture always proceeds regardless of contributors, so we skip the (paid)
 * contributor lookup entirely for it — only `strict` / `audit_only` need to
 * know whether external changes are present.
 */
async function evaluatePosture(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
  integration: DispatchedIntegration,
): Promise<PostureDecision> {
  if (context.governancePosture === "open") {
    // `open` short-circuits BEFORE any paid lookup — no contributor probe AND no
    // identity resolution (both cost a GitHub call), so the paid `GET /user`/`GET
    // /app` is skipped exactly like the contributor probe.
    return decidePosture("open", { hasExternalChange: false, externalLogins: [] });
  }
  const probe = input.contributorProbe ?? buildContributorProbe(input, context, repo, pullNumber);
  const contributors = await probe.listContributors();
  // MERGE-SAFETY (self-identity): the AUTHORITATIVE Tanren login is resolved HERE,
  // lazily (only for strict/audit_only, after `open` short-circuited above), from
  // the SAME credential the contributor probe + the runner's git author use — so
  // the identity set matches the login Tanren's own commits actually carry. Merged
  // additively onto `context.tanrenLogins` (the default bot login + any configured
  // overrides). A test that injects only a `contributorProbe` (no vcsProvider seam)
  // keeps the configured set.
  const resolvedLogins = await resolveTanrenLogins(input, context);
  const identity = tanrenIdentity([...context.tanrenLogins, ...resolvedLogins]);
  // GAP #3: on an AUTONOMOUS tier (reviewPolicy auto/simulated driving native_queue) a
  // posture block whose external committers are ALL configured platform/known-automation
  // logins auto-approves instead of stranding a done-run spec → 3×-churn → park. The
  // `human` tier still blocks (a real human decision). The platform set is the
  // CONFIGURABLE per-project known-bot set, not a hardcoded single `web-flow`.
  const autonomousTier =
    integration === "native_queue" && (context.reviewPolicy === "auto" || context.reviewPolicy === "simulated");
  const platformLogins = new Set(
    context.platformLogins.map((login) => login.trim().toLowerCase()).filter((l) => l !== ""),
  );
  return decidePosture(context.governancePosture, assessExternalChange(contributors, identity), {
    autonomousTier,
    platformLogins,
  });
}

/**
 * Resolve Tanren's authoritative pushing login(s) from the ACTIVE credential
 * (`resolveActorIdentity`), off the SAME credential context the contributor probe
 * resolves its token from — so the identity set and the runner's git author agree.
 * Returns `[]` (the configured/default set still applies) when no credential is
 * configured for the merge stage; a real resolution FAILURE on a configured
 * credential propagates (loud), never a silent degrade.
 */
async function resolveTanrenLogins(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
): Promise<ReadonlyArray<string>> {
  if (context.installation === undefined && context.staticCredentialRef === undefined) {
    return [];
  }
  const resolved = await input.vcsProvider.resolveToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter,
  });
  const identity = await input.vcsProvider.resolveActorIdentity(resolved);
  return [identity.login];
}

async function buildGitHubProbe(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): Promise<MergeProbe> {
  const provider = input.vcsProvider;
  const resolved = await provider.resolveToken({
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter,
  });
  const pr: PullRequestRef = { repo, number: pullNumber };
  return {
    readMergeability: () => provider.readMergeability(pr, resolved),
    updateBranch: () => provider.updateBranch(pr, resolved),
    retargetBase: (newBase) => provider.retargetPullRequestBase(pr, newBase, resolved),
    deleteIntegrationBranch: (branch) => provider.deleteBranch(repo, branch, resolved),
  };
}

/**
 * production contributor probe. Lists the PR's commits through the
 * VcsProvider and collects the distinct author + committer logins for the
 * external-change detection in the governance/review-merge decision path. Token
 * resolution is lazy — only paid when the gate actually needs contributors.
 */
function buildContributorProbe(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): ContributorProbe {
  const provider = input.vcsProvider;
  return {
    listContributors: async (): Promise<PullRequestContributors> => {
      const resolved = await provider.resolveToken({
        secrets: input.secrets,
        installation: context.installation,
        staticRef: context.staticCredentialRef,
        minter: input.githubAppMinter,
      });
      return provider.listContributors({ repo, number: pullNumber }, resolved);
    },
  };
}

async function ensureMergeTask(
  pool: RunStateClient,
  context: ReviewMergeRunContext,
  writer?: RunStateWriter,
): Promise<string> {
  return ensureSystemTask(pool, { runId: context.runId, kind: "merge", title: "Merge pull request" }, writer);
}

async function completeHeldMergeTask(
  pool: RunStateClient,
  eventStore: EventStore,
  context: ReviewMergeRunContext,
  taskId: string,
  integration: DispatchedIntegration,
  writer?: RunStateWriter,
): Promise<void> {
  await routeTaskUpdate(
    writer,
    pool,
    { taskId, transition: "done", outcome: "ok" },
    "UPDATE tasks SET status = 'done', outcome = $2, ended_at = now() WHERE task_id = $1",
    [taskId, "ok"],
  );
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.completed",
    payload: { taskKind: "merge", status: integration },
  });
}
