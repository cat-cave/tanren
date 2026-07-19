// ds-composer — the production DESIGN-SYSTEM COMPOSITION factory. Mirrors
// `buildForgeDesignAgentFactory` / `buildForgeFragmentAuthorerFactory`: it wires the
// `composeProjectWebDesignSystem` producer (the code-F2 analog for the design
// subsystem) against the shared Forge infra + a filesystem artifact store, so the
// greenfield derive composes+publishes the project's web design system and ds-3's F2D
// loop actually FIRES. Kept in its own module so `mountFeatureRoutes` adds no new
// import weight and `providerFactory.ts` stays under the module-dependency cap.
//
// The design-fragment writer boundary is the SAME allocating Forge answerer adapter
// (real LLM, real per-run scoped credentials) every other Forge surface uses — the
// composer wraps it with `wrapProviderDesignFragmentAuthorer` internally. No stub
// fallback (the §8a invariant); a deterministic test injects a fixture answerer
// through this same seam while the wiring/construction stays production code.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "../design/system/artifactStore.js";
import { composeProjectWebDesignSystem } from "../design/system/composeProjectWebDesignSystem.js";
import type { DesignFragmentDraftV1 } from "../design/system/authoring/index.js";
import { PgEventStore } from "../eventStore.js";
import type { ComposeDesignSystemCallback } from "./interview/index.js";
import { forgeAllocatingAnswererAdapter, type ForgeAnswererInfra } from "./providerFactory.js";

// The ds-1 CAS byte root. Content-addressed (and can be rebuilt), and the run-context
// reader resolves the design system from the persisted `web_writer_context` DB row
// (not these bytes), so an OS-temp root is a safe zero-config default.
const DESIGN_ARTIFACT_ROOT = join(tmpdir(), "tanren-design-artifacts");

/** Build the per-request `composeDesignSystem` seam the onboarding derive threads from
 * the shared Forge infra (the SAME allocator/SSH/identity substrate the run worker uses). */
export function buildForgeDesignSystemComposerFactory(infra: ForgeAnswererInfra): () => ComposeDesignSystemCallback {
  const artifactRoot = DESIGN_ARTIFACT_ROOT;
  return () => async (input) => {
    await composeProjectWebDesignSystem(
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
