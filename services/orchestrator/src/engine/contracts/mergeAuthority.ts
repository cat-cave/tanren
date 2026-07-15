// SP-4 — the Authority pattern: `MergeAuthorityV2`, the SOLE land decision + the sole
// host-land capability (tanren-owns-the-engine.md §0, §5; the frozen spine
// reconciliation rules 2/3). This REPLACES the V1 `MergeAuthority` outright — there is
// NO V1 kept, no delegate, no dual-run. It is the guaranteed, host-independent,
// FAIL-CLOSED core: WHAT MAKES LANDING INTO `main` OKAY. It unifies what was scattered
// across the gate + `governancePosture` + review + audit + mergeability.
//
// THE V2 SHAPE (reconciliation rule 2/3): the DECISION input is frozen + minimal — it
// owns ONLY a `subject` (a `LandSubject`) plus the fail-closed policy signals. The
// concrete land BINDING (ordered members + exact head + expected-main SHA + artifact +
// proof root + target) rides in a SEPARATE `LandBindingEnvelope`, OUTSIDE the frozen
// input, so no consumer can bolt a new field (SP-5's `runtimeBehaviorOutcome`) onto the
// decision input — SP-5 only EMITS evidence, it never calls an authority. `authorizeLand`
// accepts the (frozen input, envelope) SEPARATELY and — immediately before authorizing —
// re-validates the binding through an INJECTED {@link LandBindingRevalidator} (SP-7
// implements it; a type-only port here breaks the SP-4↔SP-7 cycle), asserting
// `envelope.subject` deep-equals `input.subject` (the TOCTOU guard).
//
// LAND SUBJECT + EFFECT (reconciliation rule 3): the ONLY land-capable subject is
// `{kind:'integration_node', id}`. Member verdicts admit/exclude/hold/bisect carry NO
// land payload. Git host + Postgres cannot share a txn, so the land runs the 4-step
// protocol — (1) persist the immutable decision + idempotent effect intent, (2) external
// idempotent CAS land via `CodeHost.landAuthorizedIntegration`, (3) record the receipt,
// (4) ambiguity ⇒ {@link EffectReconcile}`.state_unknown` → {@link LandOutcome}`.merge_state_unknown`.

import type { Finding } from "./findings.js";
import type { AuditPosture } from "./auditPosture.js";
import type { CodeHostRepoRef } from "./codeHost.js";
import type { Digest } from "./cas.js";
import type { NonNegativeFinite } from "./money.js";

// ---- Fail-closed decision inputs (each models its UNCERTAINTY explicitly) ----

/**
 * The native gate's verdict on the subject. `unknown` is a FIRST-CLASS uncertainty
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
 * The budget scope resolution. `resolved` carries the ceiling + spend, BOTH as
 * {@link NonNegativeFinite} so an UNLIMITED ceiling (`Infinity`/`NaN`/negative) is
 * UNREPRESENTABLE — closing the §5 P1 hole where a bare `number` ceiling let
 * `spent >= Infinity` read as "never exhausted". `unresolvable` MUST fail closed;
 * `not_required` is the EXPLICIT configured-absence (enforced upstream by the walker).
 */
export type BudgetScope =
  | { kind: "resolved"; ceilingUsd: NonNegativeFinite; spentUsd: NonNegativeFinite }
  | { kind: "not_required" }
  | { kind: "unresolvable"; reason: string };

/**
 * The demo-verification verdict. `unverified` is the uncertainty value that MUST
 * fail closed — closing the §5 P2 hole where `demo.completed` was emitted even with
 * failed probes. `not_required` is for projects with no demo stage configured.
 */
export type DemoVerification = "verified" | "unverified" | "not_required";

/**
 * The HITL signoff state. ALWAYS explicit (never an absent field): "no HITL
 * configured" is the EXPLICIT `not_required`, NOT an omission. `pending` holds; only
 * `not_required` or `approved` clear — nothing defaults to allow.
 */
export type HitlSignoff = "approved" | "pending" | "not_required";

/**
 * Whether the subject's conflicts are resolved. `resolved` is required to authorize;
 * `unresolved` BLOCKS — the `WorkspaceVcsCore` never-discard conflict carried here as
 * a fail-closed input.
 */
export type ConflictResolution = "resolved" | "unresolved";

// ---- Land subject + binding envelope (reconciliation rule 3) -----------------

/**
 * The ONLY land-capable subject: a resolved integration node identity. There is NO
 * other landable subject — a single PR, a raw ref, a member: none can land. `id` is
 * the scalar integration-node id (the `authority_decisions.integration_node_id`).
 */
export interface LandSubject {
  readonly kind: "integration_node";
  readonly id: string;
}

/**
 * How the authority dispositions ONE member of the bound integration node. A member
 * is `admit`ted into the land, `exclude`d (dropped from this land), `hold`d (kept but
 * not landed yet), or `bisect`ed (isolated to locate a failing member). A disposition
 * carries NO land payload — the land target is the WHOLE bound node's `headSha`, never
 * a per-member push.
 */
export type LandMemberDisposition = "admit" | "exclude" | "hold" | "bisect";

/** One ordered member of the bound integration node + its authority disposition. */
export interface LandBindingMember {
  readonly specId: string;
  readonly runId: string;
  readonly branch: string;
  readonly headSha: string;
  readonly disposition: LandMemberDisposition;
}

/** The concrete host land target the authorized commit advances into. */
export interface LandTarget {
  readonly repo: CodeHostRepoRef;
  /** The default branch the land advances (e.g. `main`). */
  readonly intoMain: string;
}

/**
 * The V2 land BINDING — the concrete, content-addressed land the authority binds a
 * decision to, held OUTSIDE the frozen {@link AuthorizeLandInput}. It carries the
 * ordered members (their dispositions), the EXACT `headSha` to land, the
 * `expectedMainSha` compare-and-swap base, the SP-3 `artifactDigest` + `proofRoot`
 * (canonical `sha256:` {@link Digest}s), the frozen `memberSetHash` (integrationNodes'
 * bare-hex member key), the `policyVersion`, and the {@link LandTarget}. Its `subject`
 * MUST deep-equal the decision input's `subject` — the injected revalidator asserts it
 * immediately before authorizing (TOCTOU).
 */
export interface LandBindingEnvelope {
  readonly subject: LandSubject;
  readonly members: ReadonlyArray<LandBindingMember>;
  /** The exact commit being landed (the materialized integration head). */
  readonly headSha: string;
  /** The sha `target.intoMain` must still point at — the compare-and-swap base. */
  readonly expectedMainSha: string;
  /** The SP-3 canonical artifact identity of the landed build (`sha256:<hex>`). */
  readonly artifactDigest: Digest;
  /** The SP-3/SP-7 proof-bundle root the gate evidence sealed to (`sha256:<hex>`). */
  readonly proofRoot: Digest;
  /** The frozen integrationNodes bare-hex member-set key (never canonicalized). */
  readonly memberSetHash: string;
  readonly policyVersion: string;
  readonly target: LandTarget;
}

// ---- The frozen decision input (rule 2: NO runtimeBehaviorOutcome) -----------

/**
 * The FROZEN decision input to `authorizeLand`. It owns ONLY a {@link LandSubject}
 * plus the fail-closed policy signals — the field set is FROZEN so no consumer bolts a
 * new field on (reconciliation rule 2: SP-5 does NOT add `runtimeBehaviorOutcome`; it
 * only EMITS evidence). The concrete land binding lives in the separate
 * {@link LandBindingEnvelope}. Each signal carries its OWN uncertainty value so the
 * truth table denies on uncertainty without an out-of-band "is this known?" check.
 */
export interface AuthorizeLandInput {
  /** The land subject (a resolved integration node) — the only land-capable subject. */
  readonly subject: LandSubject;
  readonly gateVerdict: GateVerdict;
  /** The auditor's emitted findings — the posture decides block/route over them. */
  readonly findings: ReadonlyArray<Finding>;
  /** The project's audit posture (the DORA knob the findings are judged against). */
  readonly auditPosture: AuditPosture;
  readonly reviewVerdict: ReviewMergeVerdict;
  readonly mergeability: MergeabilityState;
  readonly budget: BudgetScope;
  readonly demo: DemoVerification;
  /** REQUIRED + explicit: `not_required` when no HITL is configured (never omitted). */
  readonly hitlSignoff: HitlSignoff;
  readonly conflicts: ConflictResolution;
}

// ---- The injected binding revalidator (SP-7 implements; type-only here) ------

/** The outcome of a pre-authorize binding re-validation. */
export interface LandBindingRevalidation {
  readonly valid: boolean;
  /** Present only when `valid === false` — WHY the binding no longer holds. */
  readonly reason?: string;
}

/**
 * The INJECTED land-binding revalidator (reconciliation rule 2). SP-7 implements the
 * concrete revalidation (the gate-proof binding is still valid for the EXACT head);
 * `MergeAuthorityV2` invokes it immediately before authorizing (TOCTOU). At minimum it
 * asserts `envelope.subject` deep-equals `input.subject`. A TYPE-ONLY port here so SP-4
 * never imports SP-7 (no contract cycle).
 */
export interface LandBindingRevalidator {
  revalidate(input: {
    readonly subject: LandSubject;
    readonly envelope: LandBindingEnvelope;
  }): Promise<LandBindingRevalidation>;
}

// ---- The decision + outcome --------------------------------------------------

/**
 * The land authorization decision:
 *   - `authorized`      — every guaranteed input is in its pass state AND the binding
 *                         re-validated. ONLY this lets `land` execute the host land.
 *   - `blocked`         — at least one input failed closed (uncertain or failing), or
 *                         the binding re-validation failed. `reasons` names each.
 *   - `needs_attention` — a genuine human decision is required (HITL pending, a
 *                         `changes_requested` review). Routes to the operator.
 */
export type LandDecision = "authorized" | "blocked" | "needs_attention";

/** One reason an input failed closed (the audit trail of WHY it did not authorize). */
export interface LandBlockReason {
  /** Which input failed (e.g. `gateVerdict`, `mergeability`, `budget`, `binding`). */
  readonly input: string;
  /** The fail-closed detail. */
  readonly detail: string;
}

/**
 * The output of `authorizeLand` — the fail-closed truth table's verdict. It carries
 * the re-validated {@link LandBindingEnvelope} forward so `land` has the concrete
 * target with NO hidden state; `land` refuses unless `decision === 'authorized'`.
 * `reasons` names every failing input (empty only on `authorized`).
 */
export interface LandAuthorization {
  readonly decision: LandDecision;
  readonly subject: LandSubject;
  readonly envelope: LandBindingEnvelope;
  readonly reasons: ReadonlyArray<LandBlockReason>;
}

/**
 * The shared effect-reconcile state (reconciliation rule 3, step 4). When the external
 * CAS land fired but the durable receipt is ambiguous, the effect is NOT a plain
 * failure: it enters `state_unknown`, carrying the reconcile token the out-of-band
 * reconciler resolves. `landed`/`not_landed` are the resolved terminal states.
 */
export type EffectReconcile =
  | { readonly kind: "landed"; readonly mainSha: string }
  | { readonly kind: "not_landed"; readonly reason: string }
  | { readonly kind: "state_unknown"; readonly reason: string; readonly reconcileToken: string };

/**
 * The transactional result of `land`. On success: the new `mainSha` + the recorded
 * `auditId`. On a durable-receipt failure AFTER the external land fired, the result is
 * `merge_state_unknown` (the {@link EffectReconcile}`.state_unknown` projection) —
 * NEVER a plain failure that would leave internal state inconsistent with the host.
 */
export type LandOutcome =
  | { readonly kind: "landed"; readonly mainSha: string; readonly auditId: string }
  | { readonly kind: "merge_state_unknown"; readonly reason: string; readonly reconcileToken: string };

/**
 * `MergeAuthorityV2` — the SOLE land decision + the sole host-land driver. It accepts
 * the frozen {@link AuthorizeLandInput} and the {@link LandBindingEnvelope} SEPARATELY,
 * re-validates the binding (deep-equal subject) through the injected
 * {@link LandBindingRevalidator} before authorizing, and — only on `authorized` — runs
 * the 4-step land protocol through `CodeHost.landAuthorizedIntegration`. There is NO
 * `prepareIntegration`: the binding is materialized by the caller and handed in as the
 * envelope. A Wave-1 impl is validated against `mergeAuthorityConformance`.
 */
export interface MergeAuthorityV2 {
  /**
   * The FAIL-CLOSED truth table. Re-validates the envelope (asserting
   * `envelope.subject` deep-equals `input.subject`) via the injected revalidator, then
   * returns `authorized` ONLY when every guaranteed input is in its pass state;
   * `blocked` on any uncertain/failing input or a failed re-validation (with
   * `reasons`); `needs_attention` when a human decision is genuinely required.
   */
  authorizeLand(input: AuthorizeLandInput, envelope: LandBindingEnvelope): Promise<LandAuthorization>;

  /**
   * Execute the land TRANSACTIONALLY, ONLY for an `authorized` authorization (throws
   * on a non-authorized one). Runs the 4-step protocol: persist the decision + idempotent
   * effect intent → external idempotent CAS land (`CodeHost.landAuthorizedIntegration`)
   * → record the receipt → ambiguity ⇒ `merge_state_unknown`.
   */
  land(authorization: LandAuthorization): Promise<LandOutcome>;
}
