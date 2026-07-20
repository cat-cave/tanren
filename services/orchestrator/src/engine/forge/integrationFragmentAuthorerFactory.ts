import type { AuthoringAuthorer } from "../contracts/authoringKernel.js";
import {
  wrapProviderIntegrationFragmentAuthorer,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSpec,
} from "../integrations/fragments/index.js";
import {
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";

/** Production in-7 writer: the normal allocating Forge provider path, never a stub. */
export function buildForgeIntegrationFragmentAuthorerFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft> {
  return (target) =>
    wrapProviderIntegrationFragmentAuthorer(forgeAllocatingAnswererAdapter<IntegrationFragmentDraft>(infra, target));
}
