// The FAIL-CLOSED input mapping (tanren-owns-the-engine.md §5) — the pure boundary
// that gathers the live merge-path signals from where they live today and maps EACH
// into the `MergeAuthority` contract's explicit uncertainty-bearing enums. This is
// the place the §0 rule "deny/hold on uncertainty" is enforced at the boundary,
// once, loudly: every signal whose live form is absent / not-yet-resolved / errored
// is mapped to the enum value that BLOCKS — never silently to a passing value.
//
// WHY pure + total: keeping the mapping free of I/O lets the SAME live signals
// deterministically yield the SAME `AuthorizeLandInput`, conformance-tested with no
// DB. The live readers (gate outcome, review verdict, mergeability, budget scope,
// demo, HITL, conflict state) resolve their raw forms upstream; THIS module is the
// single, audited translation into the truth table's vocabulary.

import { type GateOutcome } from "../workflow/gate/index.js";
import { type ReviewVerdict } from "../contracts/dagLifecycle.js";
import { type PullRequestMergeability } from "../contracts/codeHostTypes.js";
import { type AuditPosture } from "../contracts/auditPosture.js";
import { type Finding } from "../contracts/findings.js";
import { isNonNegativeFinite, nonNegativeFinite } from "../contracts/money.js";
import type {
  AuthorizeLandInput,
  BudgetScope,
  DemoVerification,
  GateVerdict,
  HitlSignoff,
  LandSubject,
  MergeabilityState,
  ReviewMergeVerdict,
} from "../contracts/mergeAuthority.js";

// ---- Each live signal → its fail-closed enum --------------------------------

/**
 * Map the native gate outcome → {@link GateVerdict}. A produced verdict maps to
 * `passed`/`failed` by `outcome.passed`; a NOT-YET-RUN / errored / absent gate
 * (`undefined`) maps to `unknown`, which BLOCKS — "no verdict yet" can never read as
 * passing (§5 P0 closure for the gate input).
 */
export function gateVerdictFrom(outcome: GateOutcome | undefined): GateVerdict {
  if (outcome === undefined) {
    return "unknown";
  }
  return outcome.passed ? "passed" : "failed";
}

/**
 * Map the review poll's {@link ReviewVerdict} → {@link ReviewMergeVerdict}. Only
 * `approved` clears; `changes_requested` is a HUMAN signal (→ needs_attention in the
 * truth table); `pending` holds; and an ABSENT verdict (`undefined`) maps to `unread`
 * — the fail-closed value that NEVER absorbs without a read verdict (§5 P0 closure).
 */
export function reviewVerdictFrom(verdict: ReviewVerdict | undefined): ReviewMergeVerdict {
  switch (verdict) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes_requested";
    case "pending":
      return "pending";
    default:
      return "unread";
  }
}

/**
 * Map the host's {@link PullRequestMergeability} → {@link MergeabilityState}. The
 * enum is value-identical, but the contract's truth table only clears on `clean`:
 * `behind`/`dirty`/`blocked`/`unknown` ALL block. This DELETES the §5-P0 fail-open
 * where `ensureUpToDate` proceeded to merge on `unknown`/`blocked`. An ABSENT
 * mergeability read (`undefined`) is the most uncertain state → `unknown` (blocks).
 */
export function mergeabilityFrom(mergeability: PullRequestMergeability | undefined): MergeabilityState {
  return mergeability?.state ?? "unknown";
}

/** The raw, possibly-unresolvable budget figures the live budget read resolves. */
export interface RawBudgetScope {
  /**
   * The configured ceiling. `undefined` means the project configured NO budget — a
   * DELIBERATE absence the walker's budget gate already enforces upstream, so it
   * maps to the budget input's `not_required` (clears). This is NOT the §5-P1 hole:
   * a FAILED/UNKNOWN resolution must carry `failClosedReason` instead (→ unresolvable).
   */
  ceilingUsd: number | undefined;
  /** The cumulative spend in the budget window. */
  spentUsd: number;
  /**
   * A fail-closed reason the budget could not be RESOLVED (e.g. an unparseable
   * config, or an un-priced real-spend row whose true cost is unknown — the §5-P1
   * cases). When set, the scope is `unresolvable` (BLOCKS) REGARDLESS of `ceilingUsd`
   * — a failed resolution is NEVER read as unlimited.
   */
  failClosedReason?: string;
}

/**
 * Map the live budget read → {@link BudgetScope} through {@link nonNegativeFinite}.
 * The fail-closed line (§5-P1): a FAILED/UNKNOWN resolution (`failClosedReason`, or
 * a non-finite/negative figure) → `unresolvable` (BLOCKS) — DELETING the hole where an
 * unresolvable scope returned an effectively-unlimited ceiling. A DELIBERATELY-absent
 * ceiling (`undefined`, no fail-closed reason) → `not_required`: the project set no
 * budget AND the walker already gated on it upstream, so it is legitimately unbounded
 * here — never silently, always the explicit configured-absence value.
 */
export function budgetScopeFrom(raw: RawBudgetScope): BudgetScope {
  if (raw.failClosedReason !== undefined) {
    return { kind: "unresolvable", reason: raw.failClosedReason };
  }
  if (raw.ceilingUsd === undefined) {
    return { kind: "not_required" };
  }
  if (!isNonNegativeFinite(raw.ceilingUsd) || !isNonNegativeFinite(raw.spentUsd)) {
    return {
      kind: "unresolvable",
      reason: `budget figures not finite non-negative (ceiling=${String(raw.ceilingUsd)}, spent=${String(raw.spentUsd)})`,
    };
  }
  return { kind: "resolved", ceilingUsd: nonNegativeFinite(raw.ceilingUsd), spentUsd: nonNegativeFinite(raw.spentUsd) };
}

/** The raw demo-verification signal the live demo read resolves. */
export type RawDemoVerification = "verified" | "unverified" | "not_required";

/**
 * Map the live demo read → {@link DemoVerification}. Value-identical, but surfaced
 * through this boundary so an ABSENT/failed demo read maps to `unverified` (which
 * BLOCKS) — DELETING the §5-P2 fail-open where `demo.completed` was emitted even with
 * failed probes. `not_required` is the explicit "no demo stage configured".
 */
export function demoFrom(demo: RawDemoVerification | undefined): DemoVerification {
  return demo ?? "unverified";
}

/** The raw HITL signoff the live read resolves (REQUIRED + explicit, never omitted). */
export type RawHitlSignoff = "approved" | "pending" | "not_required";

/**
 * Map the live HITL read → {@link HitlSignoff}. An ABSENT read (`undefined`) maps to
 * `pending` (a human decision is owed) — there is NO omitted-default-allow: only an
 * explicit `not_required`/`approved` clears.
 */
export function hitlSignoffFrom(signoff: RawHitlSignoff | undefined): HitlSignoff {
  return signoff ?? "pending";
}

/** Map the live conflict state → the contract's resolved/unresolved enum. */
export function conflictResolutionFrom(resolved: boolean): "resolved" | "unresolved" {
  return resolved ? "resolved" : "unresolved";
}

// ---- The whole input ---------------------------------------------------------

/**
 * The structured live signals the merge path gathers for ONE land authorization.
 * Each field is the RAW upstream form; {@link buildAuthorizeLandInput} maps each
 * through the per-signal mappers above into the fail-closed contract enums. A signal
 * the live path could not resolve is passed as its ABSENT form (`undefined` / the
 * blocking value), so it BLOCKS — the gathering never invents a passing value.
 */
export interface MergeAuthoritySignals {
  /** The land subject (a resolved integration node) the frozen decision input owns. */
  subject: LandSubject;
  gateOutcome: GateOutcome | undefined;
  findings: ReadonlyArray<Finding>;
  auditPosture: AuditPosture;
  reviewVerdict: ReviewVerdict | undefined;
  mergeability: PullRequestMergeability | undefined;
  budget: RawBudgetScope;
  demo: RawDemoVerification | undefined;
  hitlSignoff: RawHitlSignoff | undefined;
  conflictsResolved: boolean;
}

/**
 * PURE: assemble the frozen {@link AuthorizeLandInput} from the gathered live signals,
 * mapping every uncertain/absent input to its fail-closed enum. This is the single
 * audited boundary between the live merge path and the guaranteed truth table — the
 * decision itself stays in `MergeAuthorityV2Impl.authorizeLand`, this only translates.
 * The concrete land binding rides in the separate `LandBindingEnvelope` (built by the
 * gate), never in this frozen input.
 */
export function buildAuthorizeLandInput(signals: MergeAuthoritySignals): AuthorizeLandInput {
  return {
    subject: signals.subject,
    gateVerdict: gateVerdictFrom(signals.gateOutcome),
    findings: signals.findings,
    auditPosture: signals.auditPosture,
    reviewVerdict: reviewVerdictFrom(signals.reviewVerdict),
    mergeability: mergeabilityFrom(signals.mergeability),
    budget: budgetScopeFrom(signals.budget),
    demo: demoFrom(signals.demo),
    hitlSignoff: hitlSignoffFrom(signals.hitlSignoff),
    conflicts: conflictResolutionFrom(signals.conflictsResolved),
  };
}
