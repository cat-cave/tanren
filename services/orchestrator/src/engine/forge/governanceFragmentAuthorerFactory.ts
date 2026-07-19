import type { AuthoringAuthorer } from "../contracts/authoringKernel.js";
import {
  wrapProviderGovernanceFragmentAuthorer,
  type GovernanceFragmentDraft,
  type GovernanceFragmentSpec,
} from "../governance/fragments/index.js";
import {
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";

/** Production gv-10 writer: the normal allocating Forge provider path, never a stub. */
export function buildForgeGovernanceFragmentAuthorerFactory(
  infra: ForgeAnswererInfra,
): (target: ForgeAnswererTarget) => AuthoringAuthorer<GovernanceFragmentSpec, GovernanceFragmentDraft> {
  return (target) =>
    wrapProviderGovernanceFragmentAuthorer(forgeAllocatingAnswererAdapter<GovernanceFragmentDraft>(infra, target));
}
