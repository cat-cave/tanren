// P1c: the bundle of production Forge answerer factories the route mount wires.
//
// `mountFeatureRoutes` assembles one `ForgeAnswererInfra` (allocator + SSH +
// identity ref) and needs a per-surface answerer factory for each Forge route.
// Bundling them here keeps the mount table's import surface to a single entry
// (and under the module dependency cap) while each factory stays independently
// testable in providerFactory.ts.

import {
  buildForgeConversationAnswererFactory,
  buildForgeDiscoveryAnswererFactory,
  buildForgeInterviewAnswererFactory,
  buildForgeReconAnswererFactory,
  buildForgeTriageAnswererFactory,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";
import type { InterviewAnswerer } from "./interview/index.js";
import type { DiscoveryAnswerer } from "./discovery/index.js";
import type { TriageAnswerer } from "./inbox/index.js";
import type { ReconAnswerer } from "./brownfield/index.js";
import type { ForgeConversationAnswerer } from "./conversation/index.js";

export interface ForgeRouteAnswererFactories {
  interview: (target: ForgeAnswererTarget) => InterviewAnswerer;
  discovery: (target: ForgeAnswererTarget) => DiscoveryAnswerer;
  triage: (target: ForgeAnswererTarget) => TriageAnswerer;
  recon: (target: ForgeAnswererTarget) => ReconAnswerer;
  conversation: (target: ForgeAnswererTarget) => ForgeConversationAnswerer;
}

/** Build every per-surface Forge answerer factory from the shared infra. */
export function buildForgeRouteAnswererFactories(infra: ForgeAnswererInfra): ForgeRouteAnswererFactories {
  return {
    interview: buildForgeInterviewAnswererFactory(infra),
    discovery: buildForgeDiscoveryAnswererFactory(infra),
    triage: buildForgeTriageAnswererFactory(infra),
    recon: buildForgeReconAnswererFactory(infra),
    conversation: buildForgeConversationAnswererFactory(infra),
  };
}
