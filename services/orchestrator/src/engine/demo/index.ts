// Demos-as-evidence barrel (design doc § "Native Deployment And Demos"). The demo
// role has two layers: the demo ENGINE (verifiable per-behavior evidence exercised
// against the deployed surface) and the NARRATION (the operator-facing summary
// layered on top of that evidence). Both are exported here.

export {
  DemoEngine,
  DemoProbeMissingError,
  type DemoEngineDeps,
  type DemoBehavior,
  type DemoTarget,
  type DemoResult,
} from "./demoEngine.js";
export { type BehaviorEvidence, type BehaviorEvidenceOutcome } from "./demoEvidence.js";
export {
  ProofBackedWebDemo,
  ProofBackedDemoNoBehaviorsError,
  ProofBackedDemoUnobservableError,
  EphemeralAcceptanceRunStore,
  EphemeralAcceptanceEventSink,
  type AcceptanceExecutor,
  type ProofBackedWebDemoDeps,
  type ProofBackedDemoResult,
} from "./proofBackedWebDemo.js";
export {
  type DemoPackageProbe,
  type PackageResolveResult,
  exercisePackageBehavior,
  fetchDemoPackageProbe,
  parsePackageCoordinate,
  registryMetadataUrl,
} from "./demoPackageArm.js";
export {
  type DemoDownloadProbe,
  type DownloadResult,
  exerciseDownloadBehavior,
  fetchDemoDownloadProbe,
  resolveExpectedSha256,
} from "./demoDownloadArm.js";
export {
  type DemoAppChannelProbe,
  type AppChannelPresenceResult,
  exerciseAppChannelBehavior,
  surfaceDescriptorAppChannelProbe,
} from "./demoAppChannelArm.js";

export {
  generateDemoNarration,
  buildDemoPrompt,
  templateDemoNarration,
  type DemoNarrationInput,
  type DemoNarrationResult,
  type DemoNarrationProvenance,
  type DemoBehaviorContext,
} from "./narration.js";
