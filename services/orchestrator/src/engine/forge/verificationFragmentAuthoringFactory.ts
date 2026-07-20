// rv-3 — the production VERIFICATION-FRAGMENT AUTHORING factory. Mirrors
// `designSystemComposerFactory.ts`: it assembles the `PlanCapabilityAuthoring` seam
// the `PgAcceptancePlanLoader` uses to F2-author a cited-but-missing verification
// capability, wiring the SAME allocating Forge answerer adapter (real LLM, real
// per-run scoped credentials) every other Forge surface uses. No stub fallback; a
// deterministic test injects a fixture answerer through this same seam while the
// wiring/construction stays production code.

import { PgVerificationFragmentStore } from "../repositories/verificationFragmentStore.js";
import {
  createVerificationFragmentAuthoringEvents,
  wrapProviderVerificationFragmentAuthorer,
  type PlanCapabilityAuthoring,
  type VerificationFragmentDraftV1,
} from "../verification/acceptance/index.js";
import { PgEventStore } from "../eventStore.js";
import {
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
} from "./providerFactory.js";

/** Build the `PlanCapabilityAuthoring` seam for a run's org/project scope. The answerer
 * target selects which project's credentials + runner the writer call allocates. */
export function buildForgeVerificationFragmentAuthoring(
  infra: ForgeAnswererInfra,
  target: ForgeAnswererTarget,
): PlanCapabilityAuthoring {
  return {
    deps: {
      authorer: wrapProviderVerificationFragmentAuthorer(
        forgeAllocatingAnswererAdapter<VerificationFragmentDraftV1>(infra, target),
      ),
      store: new PgVerificationFragmentStore(infra.pool),
      events: createVerificationFragmentAuthoringEvents(new PgEventStore(infra.pool)),
    },
    createdBy: "tanren.rv3",
  };
}
