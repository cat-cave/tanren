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
