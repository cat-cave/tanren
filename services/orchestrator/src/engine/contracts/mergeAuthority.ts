// The `MergeAuthority` seam (tanren-owns-the-engine.md §0, §5) — the OWNED,
// host-independent, FAIL-CLOSED decision: WHAT MAKES MERGING INTO `main` OKAY. This
// is the guaranteed core. It unifies what is today scattered across the gate +
// `governancePosture` + review + audit + mergeability, and it is the concept that
// makes the host swappable (the host just LANDS WHAT TANREN AUTHORIZED).
//
// WHY this seam (the audits it closes): §0 + §5 (audit 7). EVERY fail-open the live
// run exposed is a place "best-effort" leaked INWARD; MergeAuthority closes each by
// making the decision GUARANTEED — transactional, fail-closed (deny/hold on
// uncertainty), never silently skipped/swallowed/contingent on an external call:
//   - percolation absorbed on `audited`/`review`/`merged` WITHOUT reading the review
//     verdict → here a `changes_requested`/unread verdict is `blocked` (§5 P0).
//   - `ensureUpToDate()` proceeded to merge on `unknown`/`blocked` mergeability →
//     here `unknown`/`blocked` is `blocked` (fail-closed on uncertainty) (§5 P0).
//   - the external merge fired BEFORE the durable finalize → here `land` is
//     authorize → execute → reconcile, with a `merge_state_unknown` reconcile path,
//     never a silent inconsistency (§5 P0).
//   - budget gate returned UNLIMITED on unresolvable scope → here unresolvable
//     budget scope is `blocked` (fail-closed budget) (§5 P1).
//   - demo emitted `completed` even with failed probes → here a non-verified demo is
//     `blocked` (§5 P2).
// The output is `authorized | blocked | needs_attention`; the host land happens ONLY
// on `authorized`, in the SAME transaction that records the decision.

import type { Finding } from "./findings.js";
import type { AuditPosture } from "./auditPosture.js";
import type { IntegrationNode } from "./integrationNodes.js";

// ---- Fail-closed inputs (each models its UNCERTAINTY explicitly) -----------

/**
 * The native gate's verdict on the node. `unknown` is a FIRST-CLASS uncertainty
 * value (the gate has not produced a verdict yet) — and it fails CLOSED: an absent
 * verdict can never authorize. Never let "no verdict yet" read as "passing."
 */
export type GateVerdict = "passed" | "failed" | "unknown";

/**
 * The review verdict, including the uncertainty values that MUST fail closed.
 * `unread` (no verdict read yet) and `changes_requested` both BLOCK — closing the
 * §5 P0 hole where percolation absorbed without reading the verdict.
 */
export type ReviewMergeVerdict = "approved" | "changes_requested" | "pending" | "unread";

/**
 * The mergeability/freshness signal, including the uncertainty values that MUST
 * fail closed. `unknown` (not yet computed) and `blocked` (gated by something other
 * than freshness) both BLOCK — closing the §5 P0 `ensureUpToDate()` fail-open.
 */
export type MergeabilityState = "clean" | "behind" | "dirty" | "blocked" | "unknown";

/**
 * The budget scope resolution. `resolved` carries the ceiling + spend; `unresolvable`
 * is the uncertainty value that MUST fail closed — closing the §5 P1 hole where an
 * unresolvable scope returned UNLIMITED. There is NO "unlimited" value: an
 * unresolvable budget is `blocked`, never a silent pass.
 */
export type BudgetScope =
  | { kind: "resolved"; ceilingUsd: number; spentUsd: number }
  | { kind: "unresolvable"; reason: string };

/**
 * The demo-verification verdict. `unverified` is the uncertainty value that MUST
 * fail closed — closing the §5 P2 hole where `demo.completed` was emitted even with
 * failed probes. `not_required` is for projects with no demo stage configured.
 */
export type DemoVerification = "verified" | "unverified" | "not_required";

/** The HITL signoff, when the project/spec requires a human to MAKE a decision. */
export type HitlSignoff = "approved" | "pending" | "not_required";

/**
 * Whether the node's conflicts are resolved. `resolved` is required to authorize;
 * `unresolved` (any recorded conflict not yet resolved) BLOCKS — the
 * `WorkspaceVcsCore` never-discard conflict is carried here as a fail-closed input.
 */
export type ConflictResolution = "resolved" | "unresolved";

/**
 * The complete input to `authorizeLand` — every guaranteed-internal signal the
 * fail-closed truth table reads. Each carries its OWN uncertainty value so the
 * table can deny on uncertainty without an out-of-band "is this known?" check.
 */
export interface AuthorizeLandInput {
  /** The integration node being authorized to land (the unified run base, §3). */
  node: IntegrationNode;
  gateVerdict: GateVerdict;
  /** The auditor's emitted findings — the posture decides block/route over them. */
  findings: ReadonlyArray<Finding>;
  /** The project's audit posture (the DORA knob the findings are judged against). */
  auditPosture: AuditPosture;
  reviewVerdict: ReviewMergeVerdict;
  mergeability: MergeabilityState;
  budget: BudgetScope;
  demo: DemoVerification;
  /** Present only when the project/spec requires a human decision. */
  hitlSignoff?: HitlSignoff;
  conflicts: ConflictResolution;
}

// ---- The decision ----------------------------------------------------------

/**
 * The land authorization decision:
 *   - `authorized`      — the explicit all-clear: EVERY guaranteed input is in its
 *                         pass state. ONLY this lets `land` execute the host land.
 *   - `blocked`         — at least one input failed closed (uncertain or failing).
 *                         The land is held; `reasons` names every failing input.
 *   - `needs_attention` — a genuine human decision is required (HITL pending, or a
 *                         posture-block a human must adjudicate). Routes to the
 *                         operator, NOT a silent block.
 */
export type LandDecision = "authorized" | "blocked" | "needs_attention";

/** One reason an input failed closed (the audit trail of WHY it did not authorize). */
export interface LandBlockReason {
  /** Which input failed (e.g. `gateVerdict`, `mergeability`, `budget`). */
  input: string;
  /** The fail-closed detail (e.g. `unknown mergeability — fail closed on uncertainty`). */
  detail: string;
}

/**
 * The output of `authorizeLand` — the fail-closed truth table's verdict. Carries
 * the authorized ref (only on `authorized`) so `land` has exactly what to push, and
 * the block `reasons` (every failing input) so the decision is auditable. A
 * `LandAuthorization` is the ONLY thing `land` accepts — it cannot land without one.
 */
export interface LandAuthorization {
  decision: LandDecision;
  node: IntegrationNode;
  /** The authorized commit sha to land — present ONLY when `decision === 'authorized'`. */
  authorizedSha?: string;
  /** Every input that failed closed (empty only on `authorized`). */
  reasons: ReadonlyArray<LandBlockReason>;
}

/** Input to preparing an integration (resolve the batch into a single ref + tree). */
export interface PrepareIntegrationInput {
  node: IntegrationNode;
}

/**
 * The result of `prepareIntegration`: the resolved ref + its tree sha, plus any
 * conflicts surfaced as findings. `conflicts` non-empty means the node is NOT
 * landable yet (the resolver must engage); it is reported as findings (the engine's
 * currency), never thrown away.
 */
export interface PrepareIntegrationResult {
  resolvedRef: string;
  treeSha: string;
  conflicts: Finding[];
}

/**
 * The transactional result of `land`. On success: the new `mainSha` + the recorded
 * `auditId`. On a durable-write failure AFTER the external land fired, the result
 * enters `merge_state_unknown` (the reconcile state) — NEVER a plain failure that
 * would leave internal state inconsistent with the host (§5 P0).
 */
export type LandOutcome =
  | { kind: "landed"; mainSha: string; auditId: string }
  | { kind: "merge_state_unknown"; reason: string; reconcileToken: string };

/**
 * The `MergeAuthority` contract — the guaranteed core. It consumes findings + gate
 * + conflict + budget + demo + hitl + mergeability and calls `CodeHost.land` ONLY
 * on an explicit `authorized`. The decision is TRANSACTIONAL: authorize → execute
 * the external land → reconcile; a failed durable write enters `merge_state_unknown`,
 * never a silent inconsistency. A Wave-1 impl is validated against
 * `mergeAuthorityConformance` (the fail-closed truth table is the acceptance criteria).
 */
export interface MergeAuthority {
  /**
   * Resolve a batch (an integration node) into a single landable ref + tree, OR
   * surface the conflicts as findings (never discarding the work). The resolved ref
   * is what `authorizeLand` then judges.
   */
  prepareIntegration(input: PrepareIntegrationInput): Promise<PrepareIntegrationResult>;

  /**
   * The FAIL-CLOSED truth table. Returns `authorized` ONLY when every guaranteed
   * input is in its pass state; `blocked` when any input is uncertain/failing (with
   * `reasons`); `needs_attention` when a human decision is genuinely required. NEVER
   * authorizes on an uncertain input — deny/hold on uncertainty is the whole point.
   */
  authorizeLand(input: AuthorizeLandInput): Promise<LandAuthorization>;

  /**
   * Execute the land, TRANSACTIONALLY, ONLY for an `authorized` authorization
   * (throws if handed a non-authorized one — `land` cannot bypass the decision).
   * authorize → execute `CodeHost.landAuthorizedRef` → reconcile the durable
   * finalize. A durable-write failure after the host land returns
   * `merge_state_unknown` for the reconciler, NEVER a silent inconsistency.
   */
  land(auth: LandAuthorization): Promise<LandOutcome>;
}
