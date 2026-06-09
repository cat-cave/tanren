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
import type { CodeHost } from "../../contracts/codeHost.js";
import type { Finding } from "../../contracts/findings.js";
import type { AuditPosture } from "../../contracts/auditPosture.js";
import type { GateOutcome } from "../gate/index.js";
import type { ReviewVerdict } from "../../contracts/dagLifecycle.js";
import type { RawBudgetScope, RawDemoVerification, RawHitlSignoff } from "../../merge/mergeAuthorityInputs.js";
import type { LandFinalizer } from "../../merge/mergeAuthorityImpl.js";
import type { LandFinalizeContext } from "../../merge/mergeAuthorityLandFinalizer.js";

/** The integration modes the merge stage actually dispatches to. */
export type DispatchedIntegration = "native_queue" | "direct_merge" | "external_reviewer";

/**
 * The LIVE `MergeAuthority` bundle (tanren-owns-the-engine.md §5) — the inputs the
 * `direct_merge` / `native_queue` DRIVE land path hands to the guaranteed core when
 * `MERGE_AUTHORITY_LIVE` is on (the default). The dispatcher resolves mergeability +
 * conflict state itself (it owns the probe); the rest of the fail-closed signals are
 * gathered upstream (the run loop / coordinator) and passed RAW here, so an absent
 * signal maps to its blocking enum — never a synthesized passing value.
 *
 * Required for the live land path; when omitted (e.g. the kill-switch is off, or a
 * legacy out-of-band caller), the dispatcher falls back to the retained host merge.
 */
export interface MergeAuthorityBundle {
  /** The minimal host the authorized commit lands through (the ff-only CAS push). */
  codeHost: CodeHost;
  /** The owning org, so the durable finalize is org-scoped (RLS). */
  orgId: string;
  /**
   * Build the writer-backed `LandFinalizer` for this land (§5). Built at the call
   * site (which owns the real pg.Pool); the dispatcher supplies the run-stage
   * `LandFinalizeContext` (task id + audit envelope it computes). The finalize is the
   * §5 transactional record (`merge.completed` + spec `merged` in ONE org-scoped tx).
   */
  finalizerFor: (context: LandFinalizeContext) => LandFinalizer;
  /** The gate-config + policy identity stamped onto the integration node's proof key. */
  gateConfigHash: string;
  policyVersion: string;
  /** The native gate's outcome (a not-yet-run / errored / absent gate → blocks). */
  gateOutcome: GateOutcome | undefined;
  /**
   * The sha the latest `pre_merge` gate verdict was FOR (its `payload.headSha`). The
   * authority requires this EQUALS the head being landed — binding the verdict to the
   * EXACT commit (the gate↔land TOCTOU guard). A head-advance after the gate but before
   * the land makes `gatedHeadSha != landedHeadSha` → BLOCK. `undefined` when no verdict
   * is recorded (the gate already blocks via `gateOutcome === undefined`).
   */
  gatedHeadSha: string | undefined;
  /** The auditor's emitted findings + the project posture (the DORA block decision). */
  findings: ReadonlyArray<Finding>;
  auditPosture: AuditPosture;
  /** The review poll's verdict (only `approved` clears; absent → unread → blocks). */
  reviewVerdict: ReviewVerdict | undefined;
  /** The resolved budget scope (unresolvable → blocks; there is no unlimited). */
  budget: RawBudgetScope;
  /** The demo-verification verdict (absent/failed → unverified → blocks). */
  demo: RawDemoVerification | undefined;
  /** The HITL signoff (REQUIRED + explicit; absent → pending → needs_attention). */
  hitlSignoff: RawHitlSignoff | undefined;
}

/**
 * The outcome of the merge stage. `conflict` is the recoverable branch;
 * `blocked` is the recoverable hold — a strict-posture external change held for operator
 * approval, an audit_only observed change, OR (§3.2) a TRANSIENT authority refusal /
 * benign CAS race the recovery surface re-drives (NEVER a terminal dequeue);
 * `needs_attention` is the merge authority's GENUINE-human-decision verdict (a HITL hold /
 * changes_requested at land time) — it PARKS the spec via the SpecEscalator (frees its
 * slot, the rest of the DAG keeps moving) rather than hot-holding forever.
 */
export type MergeOutcomeKind =
  | "merged"
  | "queued"
  | "handed_off"
  | "conflict"
  | "failed"
  | "blocked"
  | "needs_attention";

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
   * THE ONE BASE-SHIFT HANDLER (§7): when present, a `behind` mergeability routes its
   * rebase through this unified hook (`BaseShiftCoordinator.rebaseOnto`) instead of the
   * separate server-side `probe.updateBranch()`. This is the fold that collapses the two
   * divergent "the base moved, re-derive the work" paths into one. Absent ⇒ the dispatcher
   * falls back to `probe.updateBranch()` (the pre-fold path retained through S2 so a
   * caller that has not yet wired the unified hook still rebases a behind branch — never a
   * silent skip). Production wires it; tests inject a recording hook to prove the route.
   */
  baseShiftRebase?: BaseShiftRebaseHook;
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
  /**
   * The pre-built LIVE `MergeAuthority` bundle (§5) — present when an out-of-band
   * caller constructs it directly OR a test injects a fake, bypassing the lazy build.
   * Production normally leaves it absent: `mergeForRun` provides a LAZY
   * `buildMergeAuthority` thunk instead (so the bundle's DB reads + CodeHost build
   * happen ONLY when a land is actually authorized, never on a conflict-out path).
   */
  mergeAuthority?: MergeAuthorityBundle;
  /**
   * LAZY builder for the `MergeAuthority` bundle (§5). `mergeForRun` provides this on
   * the live land path (direct_merge / native_queue DRIVE) when the authority is on;
   * the dispatcher invokes it ONLY inside `landViaAuthority`, AFTER `ensureUpToDate`
   * proceeds — so a branch that conflicts/holds first never pays the bundle build.
   * Absent ⇒ no live authority for this pass (the retained kill-switch host merge).
   */
  buildMergeAuthority?: () => Promise<MergeAuthorityBundle>;
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
 *
 * COMMIT-BINDING (§5): the optional `rebasedHeadSha` is the EXACT head the behind-
 * rebase advanced the PR branch to. The re-gate MUST anchor its `pre_merge`
 * gate.verdict on it (not the local workspace HEAD, which the forge-side rebase did
 * not necessarily advance) so the land authority's `gatedHeadSha === landedHeadSha`
 * holds for the behind path too — not just the clean path. Absent (resolved-tree
 * re-gate, where the workspace IS the head) ⇒ the gate binds to the workspace HEAD.
 */
export type ReGateCiHook = (input?: {
  rebasedHeadSha?: string;
}) => Promise<{ status: "passed" | "failed" | "pending" }>;

/**
 * THE ONE BASE-SHIFT HANDLER on the merge path (tanren-owns-the-engine.md §7 — "the two
 * divergent base-shift handlers → one"). When the PR branch is `behind` its base, the
 * merge dispatcher routes the rebase through THIS hook instead of a separate server-side
 * `updateBranch` — the SAME conceptual operation the change-percolation kick-off uses
 * (`BaseShiftCoordinator.rebaseOnto`): the base moved, re-derive the work by rebasing the
 * EXISTING branch in place, never regenerate. The outcome the dispatcher reads:
 *   - `rebased`    — the branch advanced onto base (re-gate then governs the merge).
 *   - `up_to_date` — a benign race (it was already current); proceed.
 *   - `conflict`   — a real conflict; route to the intent-preserving resolver.
 *   - `held`       — a fail-closed hold (the rebase could not settle); recoverable.
 * Production wires this to the unified base-shift path; tests inject a recording hook to
 * prove the `behind` mergeability flows through the one handler.
 */
export type BaseShiftRebaseHook = (input: { runId: string; baseBranch: string; headBranch?: string }) => Promise<{
  outcome: "rebased" | "up_to_date" | "conflict" | "held";
  message?: string;
  // COMMIT-BINDING (§5): the EXACT sha the branch was rebased to, surfaced on `rebased`
  // so the dispatcher's re-gate anchors its verdict on the rebased PR head (not the
  // local workspace HEAD). Absent on the legacy server-side `updateBranch` fallback,
  // which has no head sha to report ⇒ the re-gate binds to the workspace HEAD as before.
  rebasedHeadSha?: string;
}>;

export interface ConflictContext {
  runId: string;
  prUrl: string;
  prNumber: number;
  baseBranch: string;
  message: string;
}

export type ConflictResolverHook = (context: ConflictContext) => Promise<{ resolved: boolean }>;
