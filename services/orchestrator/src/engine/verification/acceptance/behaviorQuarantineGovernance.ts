// rv-17 — quarantine GOVERNANCE decision surface. A behavior classified FLAKY
// (flakeClassification.ts) may be QUARANTINED: an append-only governance state
// (engine/repositories/behaviorQuarantines.ts) whose REAL, PRODUCTION-WIRED effect today is:
//   • rv-16 regression bisection (LIVE via resolutionDagWalker → recordRegressionBisections)
//     refuses to name a culprit from a quarantined (flaky) behavior; and
//   • the quarantine record itself is anti-laundering-constrained (`assertQuarantineJustified` +
//     the 0085 DB CHECK): a quarantine can ONLY be justified by a `flaky` classification and can
//     ONLY carry gate_effect='excluded_from_green' — never a green/passed effect.
//
// NOT-YET-WIRED SEAM — be honest, do NOT overclaim: `resolveAcceptanceGate` /
// `resolveBehaviorGateContribution` below are a tested-READY gate-contribution resolver that maps
// a quarantined behavior to an explicit `needs_attention` (never green). They are NOT consumed by
// the native MergeAuthority land decision today: that decision reads the native CI `GateOutcome` +
// review + posture + budget (merge/mergeAuthorityInputs.ts) and NEVER consults behavior verdicts —
// `GateProofBundleV2.runtime_behavior` (contracts/gateProof.ts) is a spine-only contract with NO
// production producer or consumer. Wiring this resolver into the real gate is BLOCKED on the
// missing behavior-verdict → GateProofBundleV2.runtime_behavior → MergeAuthority binding node.
// Until that node lands, this resolver is a ready reader, NOT a live gate effect.
//
// DECISIVE ANTI-LAUNDERING RULE the resolver encodes (proven in behaviorQuarantineGate.test.ts):
// quarantine must NEVER launder a flaky/failing behavior into a `passed`/green result — a
// quarantined behavior is an EXPLICIT `quarantined` contribution that never counts as green.

import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import { mapVerdictOutcomeToProofVerdict } from "../../contracts/runtimeVerificationAdapters.js";
import type { FlakeClassification, VerdictObservation } from "./flakeClassification.js";

export type QuarantineTransition = "quarantine" | "release";
export type QuarantineGateEffect = "excluded_from_green" | "restored";

/** A behavior's contribution as computed by the (not-yet-wired) resolver once quarantine is applied. */
export type GateContribution = "green" | "blocked" | "inconclusive" | "quarantined";

/** The run-level status the (not-yet-wired) resolver returns once quarantine is applied. */
export type AcceptanceGateStatus = "green" | "blocked" | "needs_attention" | "inconclusive";

export class QuarantineNotJustifiedError extends Error {
  public constructor(public readonly classification: FlakeClassification) {
    super(
      `a quarantine requires a 'flaky' classification (a real recorded pass↔fail conflict); ` +
        `got '${classification}'`,
    );
    this.name = "QuarantineNotJustifiedError";
  }
}

/**
 * The in-process twin of the 0085 anti-laundering CHECK. A `quarantine` transition is JUSTIFIED
 * only by a `flaky` classification (a real observed conflict). Fails loud otherwise, so a caller
 * can never persist an unjustified quarantine that would silently exclude a behavior from the gate.
 */
export function assertQuarantineJustified(classification: FlakeClassification): void {
  if (classification !== "flaky") throw new QuarantineNotJustifiedError(classification);
}

/** The gate_effect a `quarantine` carries — ALWAYS 'excluded_from_green', never a green effect. */
export function quarantineGateEffect(transition: QuarantineTransition): QuarantineGateEffect {
  return transition === "quarantine" ? "excluded_from_green" : "restored";
}

/**
 * The gate contribution of ONE behavior verdict once quarantine is consulted. A quarantined
 * behavior is ALWAYS `quarantined` — never green, never a silent pass, regardless of its raw
 * outcome (a quarantined behavior that happens to pass is still set aside for attention, NOT
 * counted toward green). A non-quarantined behavior maps by its real outcome: passed→green,
 * a decisive failure→blocked, an inconclusive→inconclusive.
 */
export function resolveBehaviorGateContribution(
  outcome: BehaviorVerdictOutcome,
  isQuarantined: boolean,
): GateContribution {
  if (isQuarantined) return "quarantined";
  const proof = mapVerdictOutcomeToProofVerdict(outcome);
  if (proof === "passed") return "green";
  if (proof === "failed") return "blocked";
  return "inconclusive";
}

export interface GateBehaviorInput {
  readonly behaviorRevisionId: string;
  readonly outcome: BehaviorVerdictOutcome;
}

export interface GateBehaviorContribution {
  readonly behaviorRevisionId: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly quarantined: boolean;
  readonly contribution: GateContribution;
}

export interface AcceptanceGateSummary {
  readonly status: AcceptanceGateStatus;
  readonly total: number;
  readonly green: number;
  readonly blocked: number;
  readonly quarantined: number;
  readonly inconclusive: number;
  readonly behaviors: readonly GateBehaviorContribution[];
}

/**
 * The READY (not-yet-wired) gate-contribution resolver — see the module header. This is the
 * correct anti-laundering mapping for the day the behavior-verdict → GateProofBundleV2 →
 * MergeAuthority binding node lands; NO production gate consumes it today (the native land
 * decision reads the native CI GateOutcome, not behavior verdicts). Resolve a run's per-behavior
 * verdicts into an acceptance gate summary, honoring the active quarantine set. A run is `green`
 * ONLY when every behavior is green (no quarantined, no blocked, no inconclusive). Precedence when
 * not all-green:
 *   • any non-quarantined decisive failure ⇒ `blocked` (a real regression still hard-fails);
 *   • else any quarantined behavior ⇒ `needs_attention` (EXPLICITLY not green — surfaced);
 *   • else any inconclusive ⇒ `inconclusive`;
 *   • an empty run ⇒ `inconclusive` (no coverage is never green).
 * A quarantined FAILING behavior therefore yields `needs_attention`, NEVER `green` — the
 * laundering this node forbids is structurally impossible here.
 */
export function resolveAcceptanceGate(
  verdicts: readonly GateBehaviorInput[],
  quarantinedBehaviorIds: ReadonlySet<string>,
): AcceptanceGateSummary {
  const behaviors = verdicts.map((verdict): GateBehaviorContribution => {
    const quarantined = quarantinedBehaviorIds.has(verdict.behaviorRevisionId);
    return {
      behaviorRevisionId: verdict.behaviorRevisionId,
      outcome: verdict.outcome,
      quarantined,
      contribution: resolveBehaviorGateContribution(verdict.outcome, quarantined),
    };
  });
  const count = (c: GateContribution): number => behaviors.filter((b) => b.contribution === c).length;
  const green = count("green");
  const blocked = count("blocked");
  const quarantined = count("quarantined");
  const inconclusive = count("inconclusive");
  const total = behaviors.length;

  let status: AcceptanceGateStatus;
  if (blocked > 0) status = "blocked";
  else if (quarantined > 0) status = "needs_attention";
  else if (inconclusive > 0 || total === 0) status = "inconclusive";
  else status = "green";

  return { status, total, green, blocked, quarantined, inconclusive, behaviors };
}

/**
 * A read seam over the active quarantine state. Consulted LIVE by rv-16 regression bisection at
 * BOTH production call sites (the resolution walker + the operator-retry route) so a quarantined
 * behavior is never used to name a culprit. NOT consulted by the native MergeAuthority gate — that
 * binding is pending (see module header); the ready gate-contribution resolver above would consult
 * it once wired.
 */
export interface BehaviorQuarantineReader {
  /** The currently-quarantined behavior_revision ids for a project (latest transition = quarantine). */
  readActiveQuarantinedBehaviors(scope: {
    readonly orgId: string;
    readonly projectId: string;
  }): Promise<ReadonlySet<string>>;
  /** Whether ONE behavior is currently quarantined. */
  isQuarantined(
    scope: { readonly orgId: string; readonly projectId: string },
    behaviorRevisionId: string,
  ): Promise<boolean>;
}

/** A recorded quarantine/release governance transition (append-only). */
export interface QuarantineTransitionRecord {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  readonly transition: QuarantineTransition;
  readonly classification: FlakeClassification;
  readonly reason: string;
  readonly actor: string;
  readonly evidence: readonly VerdictObservation[];
  readonly contextHash: string;
  /**
   * mq-7 — the code GENERATION the transition was proven in: the artifact_digest whose recorded
   * verdicts the classification read. A quarantine speaks only for this epoch; a later generation
   * (a different artifact_digest) is re-evaluated against its OWN verdicts (see
   * {@link reevaluateQuarantineOnEpoch}). A release records the epoch it was released in.
   */
  readonly epoch: string;
}
