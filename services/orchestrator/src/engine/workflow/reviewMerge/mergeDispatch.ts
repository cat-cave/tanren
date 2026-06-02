// P3-0008: the merge stage. Runs after the review stage returns `approved`.
// Dispatches to one of the per-repo MergeIntegration modes selected from the
// project config:
//
//   direct_merge      → GitHub merge API (PUT /pulls/:n/merge)
//   mergify_queue     → apply the configured label; Mergify enqueues + merges
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
// P2a up-to-date enforcement: BEFORE the direct merge, the stage reads the PR
// branch's mergeability (`readMergeability`). A `behind` branch is auto-rebased
// via the server-side update-branch API (`updateBranch`) and its CI is re-polled
// to green (`reGateCi`) before merging — emitting `merge.behind` + `merge.rebased`
// for visibility. A `dirty` branch (or a 422 from update-branch) is routed to the
// conflict-resolver hook + the recoverable `merge.conflict` outcome, NOT merged.
// So a stale/conflicting branch is DETECTED and routed, not discovered as a raw
// 405/409 at merge time.

import type { MergeIntegration } from "../../config/shared.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { ensureSystemTask } from "../taskWriteRouting.js";
import { PgEventStore } from "../../eventStore.js";
import type { PullRequestRef, RepoRef } from "../../contracts/vcsProvider.js";
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
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
  type ReGateCiHook,
} from "./mergeDispatchTypes.js";

// Re-export the merge-stage contracts so the barrel + existing import sites keep
// pulling them from `mergeDispatch.ts` after the type extraction.
export {
  type ConflictContext,
  type ConflictResolverHook,
  type DispatchedIntegration,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type MergeProbe,
  type ReGateCiHook,
};

/** Map the configured integration to the mode the stage dispatches to. */
export function dispatchedIntegrationFor(mode: MergeIntegration): DispatchedIntegration {
  if (mode === "direct_merge" || mode === "mergify_queue" || mode === "external_reviewer") {
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

  // P2c-1 (§2c): a SPECULATIVE dependent's MERGE waits until its ancestors are
  // genuinely merged — its WORK proceeded against a speculative integration branch,
  // but no unreviewed ancestor code may reach `main` early. If the run is
  // speculative and any ancestor is still unmerged, HOLD the merge (emit
  // merge.speculative_held, return a `blocked` outcome) rather than merging against
  // the integration base. The DagWalker re-walks on the ancestor's merge.completed,
  // which re-enters this stage once the ancestors land.
  const hold = await speculativeMergeHold(input.pool, context.runId);
  if (hold !== undefined) {
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
        speculativeBase: hold.speculativeBase,
        unmergedAncestors: hold.unmergedAncestors,
      },
    });
    return {
      runId: context.runId,
      taskId,
      integration,
      outcome: "blocked",
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
      message: `merge held: ancestors not yet merged (${hold.unmergedAncestors.join(", ")})`,
    };
  }

  const probe = input.mergeProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));
  const dispatcher = new MergeDispatcher({
    input,
    context,
    eventStore,
    taskId,
    integration,
    pr,
    probe,
  });

  // P3-0023 governance posture gate. Only Tanren-initiated auto-merges
  // (direct_merge / mergify_queue) are governed: a strict-posture external
  // change blocks (operator approval required); an audit_only external change
  // is observed (no merge call). The external_reviewer / not_configured
  // hand-off is already a human-merge path — Tanren is not auto-merging, so
  // there is nothing for the posture to block and the gate is skipped.
  if (integration !== "external_reviewer") {
    const decision = await evaluatePosture(input, context, pr.repo, pr.pullNumber);
    if (decision.kind !== "proceed") {
      return dispatcher.blockByPosture(decision);
    }
  }

  if (integration === "external_reviewer") {
    return dispatcher.handOff();
  }
  if (integration === "mergify_queue") {
    return dispatcher.enqueueMergify();
  }
  return dispatcher.directMerge();
}

/**
 * P2c-1 (§2c): determine whether this run's MERGE must be HELD because it is a
 * speculative dependent whose ancestors are not all merged yet. Returns the hold
 * detail (the speculative base + the unmerged ancestor spec ids) when the merge
 * must wait, or `undefined` when it may proceed (a normal run, or a speculative
 * one whose ancestors have all since merged). A `done`/`merged` ancestor is
 * satisfied; anything else is unmerged. This is the safety property that no
 * unreviewed ancestor code reaches `main` early — the dependent's WORK ran on the
 * integration branch, but its MERGE waits for the real ancestor merges.
 */
async function speculativeMergeHold(
  pool: RunStateClient,
  runId: string,
): Promise<{ speculativeBase: string; unmergedAncestors: string[] } | undefined> {
  const runResult = await pool.query<{ speculative_base: string | null; spec_id: string; project_id: string }>(
    "SELECT speculative_base, spec_id, project_id FROM runs WHERE run_id = $1",
    [runId],
  );
  const run = runResult.rows[0];
  if (run === undefined || run.speculative_base === null) {
    return undefined;
  }
  const specResult = await pool.query<{ depends_on: string[] | null }>(
    "SELECT depends_on FROM specs WHERE spec_id = $1",
    [run.spec_id],
  );
  const dependsOn = (specResult.rows[0]?.depends_on ?? []).filter((id): id is string => typeof id === "string");
  if (dependsOn.length === 0) {
    return undefined;
  }
  // The ancestors that are genuinely merged (status done/merged); the rest are
  // unmerged and the merge must wait on them.
  const mergedResult = await pool.query<{ spec_id: string }>(
    "SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY($2::text[]) AND status IN ('done', 'merged')",
    [run.project_id, dependsOn],
  );
  const merged = new Set(mergedResult.rows.map((row) => row.spec_id));
  const unmergedAncestors = dependsOn.filter((id) => !merged.has(id));
  if (unmergedAncestors.length === 0) {
    return undefined;
  }
  return { speculativeBase: run.speculative_base, unmergedAncestors };
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
): Promise<PostureDecision> {
  if (context.governancePosture === "open") {
    return decidePosture("open", { hasExternalChange: false, externalLogins: [] });
  }
  const probe = input.contributorProbe ?? buildContributorProbe(input, context, repo, pullNumber);
  const contributors = await probe.listContributors();
  const identity = tanrenIdentity(context.tanrenLogins);
  return decidePosture(context.governancePosture, assessExternalChange(contributors, identity));
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
    applyQueueLabel: (label) => provider.applyQueueLabel(pr, label, resolved),
    merge: () => provider.mergePullRequest(pr, resolved, input.mergeMethod),
    readMergeability: () => provider.readMergeability(pr, resolved),
    updateBranch: () => provider.updateBranch(pr, resolved),
  };
}

/**
 * P3-0023 production contributor probe. Lists the PR's commits through the
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
