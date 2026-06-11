// The merge-stage shared contracts (result/input shapes, the merge/conflict/
// re-gate hooks, and the noop conflict-resolver default). Extracted into a leaf
// module so both mergeDispatch.ts (mergeForRun) and mergeDispatcher.ts (the
// MergeDispatcher class) import them WITHOUT forming an import cycle, and so each
// file stays under the 500-line architecture cap.

import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { EventStore } from "../../eventStore.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { PullRequestMergeability } from "../../contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "../../providers/github.js";
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
 * The `MergeAuthority` bundle (tanren-owns-the-engine.md §5) — the inputs the
 * `direct_merge` / `native_queue` DRIVE land path hands to the guaranteed core (the
 * sole, unconditional land authority). The dispatcher resolves mergeability + conflict
 * state itself (it owns the probe); the rest of the fail-closed signals are gathered
 * upstream (the run loop / coordinator) and passed RAW here, so an absent signal maps to
 * its blocking enum — never a synthesized passing value.
 *
 * REQUIRED for any land: an absent bundle is a fail-closed BLOCK (the dispatcher holds
 * loudly), never a fall-through that lands without the guaranteed truth table.
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
  /** The shared (timed) GitHub HTTP client the merge stage's host seams build over. */
  githubHttp: GitHubHttpClient;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /** Run-resolved GitHub credential ref; see PollReviewForRunInput. */
  resolvedGithubCredentialRef?: string;
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for the
   * mergeability/branch-state probe operations (readMergeability / updateBranch /
   * retargetBase). Production omits it → the dispatcher builds
   * the real probe through the resolved token. NOT a land path: the land is the
   * unconditional `MergeAuthority`, regardless of this seam.
   */
  mergeProbe?: MergeProbe;
  /**
   * test seam. Resolves the PR's distinct contributor logins for
   * external-change detection. Production omits it → the dispatcher reads the
   * commit authors over the sha range through `CodeHost.readCommitAuthors`.
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
   * green is stale). Production wires this to `pollCiForRun` over the SAME
   * GitHub HTTP client; tests inject a scripted re-gate. Post-rebase re-gating is
   * REQUIRED: when the branch was actually rebased and this hook is omitted, the
   * stage HARD-HOLDS (emits `merge.rebased` with `reGatedCi: false`, then the
   * recoverable `merge.conflict` outcome) rather than merging on unverified CI —
   * a missing required re-gate is a hold, never "merge anyway".
   */
  reGateCi?: ReGateCiHook;
  /**
   * THE ONE BASE-SHIFT HANDLER (§7 / decomposition PR-7 §5h): a `behind` freshness routes its
   * rebase through this unified hook (`BaseShiftCoordinator.rebaseOnto`) — the SOLE rebase
   * path. The legacy server-side `update-branch` fallback is GONE: this hook is wired
   * UNCONDITIONALLY on every land-driving caller (the in-loop `direct_merge` via
   * `baseShiftRebaseSeam`, the native_queue DRIVE via `coordinatorBuild`). Absent ⇒ a
   * fail-closed HOLD (a wiring bug), never a silent server-side update. Tests inject a
   * recording hook to prove the route.
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
   * The pre-built `MergeAuthority` bundle (§5) — present when an out-of-band caller
   * constructs it directly OR a test injects a fake, bypassing the lazy build.
   * Production normally leaves it absent: `mergeForRun` provides a LAZY
   * `buildMergeAuthority` thunk instead (so the bundle's DB reads + CodeHost build
   * happen ONLY when a land is actually authorized, never on a conflict-out path).
   */
  mergeAuthority?: MergeAuthorityBundle;
  /**
   * LAZY builder for the `MergeAuthority` bundle (§5). `mergeForRun` provides this on the
   * land-driving pass (direct_merge / native_queue DRIVE); the dispatcher invokes it ONLY
   * inside `landViaAuthority`, AFTER `ensureUpToDate` proceeds — so a branch that
   * conflicts/holds first never pays the bundle build. Absent + no pre-built
   * `mergeAuthority` ⇒ the dispatcher FAIL-CLOSED-blocks the land (no host-merge fallback).
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

/**
 * Injectable FRESHNESS probe (real `CodeHost`-derived by default; mocked in tests).
 * NOT a land path — the land is the unconditional `MergeAuthority` + `CodeHost` CAS.
 *
 * §5h SEVER (decomposition PR-7): freshness is NO LONGER the GitHub `mergeable_state`
 * read. `readFreshness` derives the `clean`/`behind` signal from a `CodeHost.fetchRef` +
 * `CodeHost.compareRefs` ANCESTRY comparison of the PR's base/head shas — a pure
 * commit-graph fact, never a host 3-way merge. CONFLICT is NOT derived here: a `behind`
 * branch routes through the unified `baseShiftRebase` (jj), which surfaces a genuine
 * conflict itself — the host HOSTS, the jj rebase DECIDES conflict. So `readFreshness`
 * yields only `clean` / `behind` / `unknown` (an unresolvable base/head sha), never `dirty`.
 */
export interface MergeProbe {
  /**
   * Derive the PR branch's up-to-date / freshness state from the host ANCESTRY of its
   * base/head shas (`CodeHost.fetchRef` + `compareRefs`) — `clean` (head contains base),
   * `behind` (base advanced past head), or `unknown` (an unresolvable sha). NEVER `dirty`:
   * conflict is surfaced by the jj rebase, not a `mergeable_state` read.
   */
  readFreshness(): Promise<PullRequestMergeability>;
  /**
   * The PR's current BASE branch name — read for the speculative stacked-PR retarget
   * walk's `fromBase` (a forge-PR-shaped read that belongs to the §7-deferred
   * speculative-retarget cleanup, NOT the freshness coupling). Returns `""` when the
   * base cannot be read.
   */
  readBaseBranch(): Promise<string>;
  /**
   * §2c step 3: re-point the PR's base to `newBase` (default_branch) when a speculative
   * dependent's hold clears, so it lands on real `main`. Routed through the best-effort
   * `VisibilityProjection.retargetChangeRequest` (decomposition PR-7 / §5h item 3) — the
   * base re-point is a forge-UI mirror op, not a host-decision.
   */
  retargetBase(newBase: string): Promise<void>;
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
