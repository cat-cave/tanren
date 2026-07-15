import type { SensitivityRule } from "./sensitivity.js";

const EVENT = "behavior.coverage.selection_analyzed";

/** The selection fact contains identifiers, graph refs, and verdict labels only. */
export const runtimeVerificationSensitivityRules: SensitivityRule[] = [
  "version",
  "analysisId",
  "mode",
  "changedTargets",
  "changedTargets[].kind",
  "changedTargets[].targetRef",
  "unknownTargets",
  "unknownTargets[].kind",
  "unknownTargets[].targetRef",
  "selected",
  "selected[].behaviorRevisionId",
  "selected[].reasons",
  "selected[].reasons[].kind",
  "selected[].reasons[].edgeId",
  "selected[].reasons[].target.kind",
  "selected[].reasons[].target.targetRef",
  "selected[].reasons[].dependencyBehaviorRevisionId",
  "selected[].reasons[].targetRef",
  "excluded",
  "excluded[].behaviorRevisionId",
  "excluded[].reason",
  "excluded[].inspectedEdgeIds",
  "excluded[].inspectedEdgeIds[]",
].map((path) => ({ eventName: EVENT, path, tag: "public" }));
