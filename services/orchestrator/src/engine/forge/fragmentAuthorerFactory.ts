// Production fragment-authorer factory (docs/roadmap/templating-system.md F2).
//
// Mirrors `buildForgeDesignAgentFactory` — extracted to its own file to keep
// `providerFactory.ts` under the max-dependencies cap. Wraps the allocating
// Forge answerer adapter (real LLM, real cost, real per-run scoped credentials)
// with `wrapProviderFragmentAuthorer` so each fragment-authoring call goes
// through the SAME structured-output infra the planner/checker/auditor use.

import {
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";
import {
  wrapProviderFragmentAuthorer,
  type FragmentAuthorer,
  type FragmentAuthorerOutput,
} from "../templates/index.js";

export function buildForgeFragmentAuthorerFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => FragmentAuthorer {
  return (target) =>
    wrapProviderFragmentAuthorer(forgeAllocatingAnswererAdapter<FragmentAuthorerOutput>(infra, target));
}
