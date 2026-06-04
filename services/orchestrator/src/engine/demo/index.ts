// Demos-as-evidence barrel (design doc § "Native Deployment And Demos"). The demo
// role has two layers: the demo ENGINE (verifiable per-behavior evidence exercised
// against the deployed surface) and the NARRATION (the operator-facing summary
// layered on top of that evidence). Both are exported here.

export { DemoEngine, type DemoEngineDeps, type DemoBehavior, type DemoTarget, type DemoResult } from "./demoEngine.js";
export {
  type BehaviorEvidence,
  type BehaviorEvidenceOutcome,
  type DemoWebProbe,
  exerciseWebBehavior,
  resolveBehaviorSurfacePath,
  joinSurfaceUrl,
} from "./demoEvidence.js";
export { fetchDemoWebProbe } from "./demoWebProbe.js";

export {
  generateDemoNarration,
  buildDemoPrompt,
  templateDemoNarration,
  type DemoNarrationInput,
  type DemoNarrationResult,
  type DemoNarrationProvenance,
  type DemoBehaviorContext,
} from "./narration.js";
