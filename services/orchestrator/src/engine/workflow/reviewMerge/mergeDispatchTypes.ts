// The merge-stage shared contracts (result/input shapes, the merge/conflict/
// re-gate hooks, and the noop conflict-resolver default). Extracted into a leaf
// module so both mergeDispatch.ts (mergeForRun) and mergeDispatcher.ts (the
// MergeDispatcher class) import them WITHOUT forming an import cycle, and so each
// file stays under the 500-line architecture cap.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { EventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { MergePullRequestResult } from "../../providers/githubReviewMerge.js";
import type { PullRequestMergeability, UpdateBranchResult, VcsProvider } from "../../contracts/vcsProvider.js";
import type { RunStateClient } from "./context.js";
import type { ContributorProbe } from "./governancePosture.js";

/** The integration modes the merge stage actually dispatches to. */
export type DispatchedIntegration = "mergify_queue" | "direct_merge" | "external_reviewer";

/**
 * The outcome of the merge stage. `conflict` is the recoverable branch;
 * `blocked` is the P3-0023 governance-posture outcome — a strict-posture
 * external change held for operator approval, or an audit_only observed change.
 */
export type MergeOutcomeKind = "merged" | "queued" | "handed_off" | "conflict" | "failed" | "blocked";

export interface MergeForRunResult {
  runId: string;
  taskId: string;
  integration: DispatchedIntegration;
  outcome: MergeOutcomeKind;
  prUrl: string;
  prNumber: number;
  mergeSha?: string;
  message?: string;
}

export interface MergeForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // Plane-split P3c: route the merge task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /** Run-resolved GitHub credential ref; see PollReviewForRunInput. */
  resolvedGithubCredentialRef?: string;
  /** Label applied for the mergify_queue path; defaults to `tanren:merge`. */
  mergifyQueueLabel?: string;
  /** GitHub merge method for direct_merge; defaults to `squash`. */
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for the
   * label/merge operations. Production omits it → the real
   * GitHubReviewMergeService drives both through the resolved token.
   */
  mergeProbe?: MergeProbe;
  /**
   * P3-0023 test seam. Resolves the PR's distinct contributor logins for
   * external-change detection. Production omits it → the dispatcher lists the
   * PR commits through the VcsProvider and derives the logins.
   */
  contributorProbe?: ContributorProbe;
  /**
   * P2b intent-preserving conflict resolver — a REQUIRED merge-stage input.
   * Invoked on a detected merge conflict BEFORE the recoverable `merge.conflict`
   * outcome is emitted. Production wires the real
   * `intentPreservingConflictResolver` (built from the run's merge-stage context,
   * resolved from the project routing like the other Answerers); tests inject a
   * fake under tests/. Returning `resolved: true` (only after a clean re-gate of
   * a both-intents-preserving resolution) lets the dispatcher retry the merge
   * once. There is no noop default (§8a): a conflict is always routed to a real
   * resolver, never silently dropped.
   */
  resolveConflict: ConflictResolverHook;
  /**
   * P2a up-to-date enforcement: re-poll the run's CI to a terminal verdict after
   * an auto-rebase advanced the branch (the branch HEAD moved, so the prior
   * green is stale). Production wires this to `pollCiForRun` through the SAME
   * vcsProvider seam; tests inject a scripted re-gate. When omitted, the stage
   * skips the re-poll (it still emits `merge.rebased` with `reGatedCi: false`)
   * and proceeds to let the GitHub merge API gate on required checks — the merge
   * is never forced past protection.
   */
  reGateCi?: ReGateCiHook;
}

/** Injectable merge-operation probe (real GitHub by default; mocked in tests). */
export interface MergeProbe {
  applyQueueLabel(label: string): Promise<void>;
  merge(): Promise<MergePullRequestResult>;
  /** P2a: read the PR branch's up-to-date / mergeability state before merging. */
  readMergeability(): Promise<PullRequestMergeability>;
  /** P2a: bring the PR branch up to date with its base (server-side update). */
  updateBranch(): Promise<UpdateBranchResult>;
  /**
   * P2c-1 (§2c step 3): re-point the PR's base to `newBase` (default_branch) when
   * a speculative dependent's hold clears, so it lands on real `main`, not the
   * ephemeral integration ref. Followed by the P2a rebase + re-gate flow.
   */
  retargetBase(newBase: string): Promise<void>;
  /**
   * P2c-1 (§2c cleanup): delete the ephemeral integration ref after the dependent
   * merged. Best-effort + idempotent (a missing ref is success).
   */
  deleteIntegrationBranch(branch: string): Promise<void>;
}

/**
 * P2a re-gate hook: drive the run's CI back to a terminal verdict after a
 * rebase. Returns the CI status so the stage knows whether to merge (`passed`),
 * fail (`failed`), or hold (`pending` after the budget). Production resolves
 * this to a `pollCiForRun` loop; tests inject a scripted result.
 */
export type ReGateCiHook = () => Promise<{ status: "passed" | "failed" | "pending" }>;

export interface ConflictContext {
  runId: string;
  prUrl: string;
  prNumber: number;
  baseBranch: string;
  message: string;
}

export type ConflictResolverHook = (context: ConflictContext) => Promise<{ resolved: boolean }>;
