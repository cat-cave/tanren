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
export type DispatchedIntegration = "native_queue" | "direct_merge" | "external_reviewer";

/**
 * The outcome of the merge stage. `conflict` is the recoverable branch;
 * `blocked` is the governance-posture outcome — a strict-posture
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
  // route the merge task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /** Run-resolved GitHub credential ref; see PollReviewForRunInput. */
  resolvedGithubCredentialRef?: string;
  /** GitHub merge method for direct_merge; defaults to `squash`. */
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for the
   * label/merge operations. Production omits it → the real
   * GitHubReviewMergeService drives both through the resolved token.
   */
  mergeProbe?: MergeProbe;
  /**
   * test seam. Resolves the PR's distinct contributor logins for
   * external-change detection. Production omits it → the dispatcher lists the
   * PR commits through the VcsProvider and derives the logins.
   */
  contributorProbe?: ContributorProbe;
  /**
   * intent-preserving conflict resolver — a REQUIRED merge-stage input.
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
   * up-to-date enforcement: re-poll the run's CI to a terminal verdict after
   * an auto-rebase advanced the branch (the branch HEAD moved, so the prior
   * green is stale). Production wires this to `pollCiForRun` through the SAME
   * vcsProvider seam; tests inject a scripted re-gate. Post-rebase re-gating is
   * REQUIRED: when the branch was actually rebased and this hook is omitted, the
   * stage HARD-HOLDS (emits `merge.rebased` with `reGatedCi: false`, then the
   * recoverable `merge.conflict` outcome) rather than merging on unverified CI —
   * a missing required re-gate is a hold, never "merge anyway".
   */
  reGateCi?: ReGateCiHook;
  /**
   * native_queue: the hook that ENTERS a ready run into Tanren's native
   * merge queue (instead of merging immediately). Required ONLY when the resolved
   * integration is `native_queue` AND this is the run-loop's first pass (not the
   * coordinator DRIVE pass) — the dispatcher calls it to persist the queue entry +
   * emit merge.queued, then finalizes the run as queued. Idempotent: a run already
   * queued/merging is not re-queued (the model dedupes). Production wires the
   * PgMergeQueueModel-backed enqueuer; tests inject a fake. Absent on the drive
   * pass (the coordinator already dequeued + claimed) and for every other mode.
   */
  enqueueNativeQueue?: NativeQueueEnqueuer;
  /**
   * native_queue: the DRIVE flag. The native queue's MergeCoordinator calls
   * mergeForRun a SECOND time for the claimed head run with `queueDrive: true` —
   * which runs the SAME directMerge logic (up-to-date/rebase + conflict-resolution
   * + retarget) as `direct_merge`, but labels its events `native_queue`. Absent
   * (the default) on the run-loop's first
   * pass, where `native_queue` ENQUEUES instead of merging. This is how the
   * coordinator reuses the per-run merge path without a second merge impl.
   */
  queueDrive?: boolean;
}

/**
 * enters a ready-to-merge run into the native merge queue. Returns whether the
 * entry was newly created (so merge.queued is emitted exactly once). The pg impl
 * persists the row under RLS via the MergeQueueModel; a test injects a fake.
 */
export type NativeQueueEnqueuer = (input: {
  projectId: string;
  runId: string;
  specId: string;
  prUrl: string;
  prNumber: number;
}) => Promise<{ created: boolean }>;

/** Injectable merge-operation probe (real GitHub by default; mocked in tests). */
export interface MergeProbe {
  merge(): Promise<MergePullRequestResult>;
  /** read the PR branch's up-to-date / mergeability state before merging. */
  readMergeability(): Promise<PullRequestMergeability>;
  /** bring the PR branch up to date with its base (server-side update). */
  updateBranch(): Promise<UpdateBranchResult>;
  /**
   * §2c step 3: re-point the PR's base to `newBase` (default_branch) when
   * a speculative dependent's hold clears, so it lands on real `main`, not the
   * ephemeral integration ref. Followed by the rebase + re-gate flow.
   */
  retargetBase(newBase: string): Promise<void>;
  /**
   * §2c cleanup: delete the ephemeral integration ref after the dependent
   * merged. Best-effort + idempotent (a missing ref is success).
   */
  deleteIntegrationBranch(branch: string): Promise<void>;
}

/**
 * re-gate hook: drive the run's CI back to a terminal verdict after a
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
