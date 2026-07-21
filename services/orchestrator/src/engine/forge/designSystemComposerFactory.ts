// ds-composer — the production DESIGN-SYSTEM COMPOSITION factory. Mirrors
// `buildForgeDesignAgentFactory` / `buildForgeFragmentAuthorerFactory`: it wires
// the `composeProjectTargetDesignSystems` producer (the multi-target code-F2
// analog for the design subsystem) against the shared Forge infra + a
// filesystem artifact store, so the greenfield derive composes+publishes the
// project's design system across every required V2 target profile and ds-3's
// F2D loop actually FIRES. Kept in its own module so `mountFeatureRoutes`
// adds no new import weight and `providerFactory.ts` stays under the
// module-dependency cap.
//
// The design-fragment writer boundary is the SAME allocating Forge answerer
// adapter (real LLM, real per-run scoped credentials) every other Forge surface
// uses — the composer wraps it with `wrapProviderDesignFragmentAuthorer`
// internally. No stub fallback (the §8a invariant); a deterministic test
// injects a fixture answerer through this same seam while the
// wiring/construction stays production code.

import { DEFAULT_DESIGN_ARTIFACT_ROOT, FilesystemArtifactStore } from "../design/system/artifactStore.js";
import { composeProjectTargetDesignSystems } from "../design/system/composeProjectTargetDesignSystems.js";
import type { DesignFragmentDraftV1 } from "../design/system/authoring/index.js";
import { PgEventStore } from "../eventStore.js";
import type { ComposeDesignSystemCallback } from "./interview/index.js";
import { forgeAllocatingAnswererAdapter, type ForgeAnswererInfra } from "./providerFactory.js";

/** Build the per-request `composeDesignSystem` seam the onboarding derive threads from
 * the shared Forge infra (the SAME allocator/SSH/identity substrate the run worker uses). */
export function buildForgeDesignSystemComposerFactory(infra: ForgeAnswererInfra): () => ComposeDesignSystemCallback {
  // Shared CAS root (artifactStore.ts): the ds-5 export route reads the same bytes.
  const artifactRoot = DEFAULT_DESIGN_ARTIFACT_ROOT;
  return () => async (input) => {
    await composeProjectTargetDesignSystems(
      {
        pool: infra.pool,
        artifactStore: new FilesystemArtifactStore(artifactRoot),
        fragmentAnswerer: forgeAllocatingAnswererAdapter<DesignFragmentDraftV1>(infra, {
          orgId: input.orgId,
          projectId: input.projectId,
        }),
        eventStore: new PgEventStore(infra.pool),
        createdBy: "tanren.ds-composer",
      },
      input,
    );
  };
}
