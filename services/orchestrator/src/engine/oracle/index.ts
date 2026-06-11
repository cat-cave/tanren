// The native entity-change RISK ORACLE (docs/roadmap/entity-analysis-layer.md
// §3.1): a deterministic risk-triage + structural verdict the checker reasons
// over BEFORE the LLM judgement. The taxonomy is the durable, language-agnostic
// asset (the generality mechanism); `sem` is one optional producer of its input.
export {
  classifyEntityRisk,
  riskClassRank,
  isUnexpectedRiskFailure,
  type EntityChange,
  type EntityChangeKind,
  type EntityChangeNature,
  type EntityChangeMap,
  type EntityVisibility,
  type EntityRiskClass,
  type EntityRiskProvenance,
  type EntityRiskSignal,
  type UnavailableReason,
} from "./entityRiskTaxonomy.js";

export { checkerPostureFor, renderRiskPostureLines, type CheckerRiskPosture } from "./checkerRiskPosture.js";

// §3.3: the SELF-VALIDATING CLAIM oracle — the durable form of the §2.3 staleness
// check. A Claim anchored to an entity self-resolves ONLY on positive evidence the
// entity is GONE; absence of evidence keeps it open (no-silent-fallback). Pure
// decision core; the driver (claimSelfValidationDriver.ts) runs the producer + persists.
export {
  validateClaimAgainstEntity,
  type EntityProbeOutcome,
  type EntityProbeStatus,
  type ProbeUnavailableReason,
  type ClaimSelfValidationVerdict,
  type ClaimSelfValidationTransition,
  type ClaimDecidability,
} from "./claimSelfValidation.js";
