// WS-D3 (native-design-subsystem.md) — the production DESIGN-AGENT factory. Kept in
// its own module (rather than alongside the other Forge factories in
// providerFactory.ts) so providerFactory stays under the per-file module-dependency
// cap; it reuses the shared `forgeAllocatingAnswererAdapter` (the allocate → resolve
// → one-call → release adapter) exactly like every other Forge surface factory.
//
// The design agent ELABORATES the thin captured design intent (WS-D1) into a full,
// persona-scoped, behavior-covering, domain-appropriate `DesignContract` — the design
// PHASE that runs during derive, before the build nodes. Greenfield onboarding has no
// project yet, so it resolves the ORG's default LLM credential (org-scoped, like the
// greenfield interview). There is no deterministic fallback (the §8a invariant).

import { wrapProviderDesignAgent, type DesignAgent, type DesignAgentAnswer } from "../design/designAgent.js";
import {
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";

/** Build a production DESIGN-AGENT factory from the shared Forge infra (org-scoped). */
export function buildForgeDesignAgentFactory(infra: ForgeAnswererInfra): (target: ForgeAnswererTarget) => DesignAgent {
  return (target) => wrapProviderDesignAgent(forgeAllocatingAnswererAdapter<DesignAgentAnswer>(infra, target));
}
