// P3-0014 spec discovery barrel. The discovery route + tests import the typed
// surface from here.

export {
  DiscoveryVariant,
  DiscoveryInsight,
  ProposedSpec,
  PlacementKind,
  PlacementOption,
  ImpactDelta,
  DiscoveryResult,
  type DiscoveryAnswerer,
  type DiscoveryAnswererContext,
} from "./types.js";

export {
  classifyInsight,
  acceptProposals,
  type DiscoveryEngineDeps,
  type ClassifyInput,
  type AcceptInput,
  type AcceptResult,
  type AcceptedSpec,
} from "./engine.js";

export {
  DISCOVERY_METADATA_KEY,
  DiscoveryProvenance,
  withDiscoveryProvenance,
  parseDiscoveryProvenance,
  writeProvenance,
  readProvenance,
} from "./provenance.js";

export { createDeterministicDiscoveryAnswerer } from "./defaultAnswerer.js";
