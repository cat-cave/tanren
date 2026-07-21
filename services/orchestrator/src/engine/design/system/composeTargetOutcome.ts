// ds-7 — the per-target outcome builder, extracted from the multi-target composer
// to keep that file under the import-dependency cap. One runtime entry point
// (`composeTargetOutcome`) handles BOTH web-react AND framework targets —
// returning the published artifactId + the recorded conformance run.

import { persistFrameworkDesignArtifact } from "./frameworkArtifactPersistence.js";
import type { DesignAdapterConformanceStore, DesignAdapterConformanceRunRow } from "./adapterConformanceStore.js";
import type { DesignAdapterConformanceTarget } from "./adapterConformanceReceipt.js";
import type { DesignTargetAdapterSet } from "./designTargetRegistry.js";
import type { FrameworkDesignTargetAdapter } from "./frameworkAdapterCore.js";
import {
  buildFrameworkArtifact,
  encodeFrameworkManifest,
  newConformanceRunId,
  newTargetArtifactId,
  recordFrameworkConformanceRun,
  resolveFrameworkAdapter,
} from "./composeProjectTargetDesignSystemsHelpers.js";
import { publishWebTarget, recordWebConformanceRun, type TargetCompositionContext } from "./composeWebTarget.js";
import type { ComposeProjectTargetDesignSystemsDeps } from "./composeProjectTargetDesignSystems.js";
import { WEB_DESIGN_TARGET } from "./webAdapter.js";

/** The result of composing one target — published + recorded, or the typed failure that blocked. */
export interface ComposeTargetOutcomeResult {
  readonly target: DesignAdapterConformanceTarget;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly conformanceRunId: string;
  readonly conformanceOutcome: DesignAdapterConformanceRunRow["outcome"];
  readonly canonicalForRelease: boolean;
}

/**
 * Compose one target's artifact + record its conformance receipt. For web-react:
 * publish through the rich ds-2 adapter (canonical release artifact). For non-web
 * targets: persist through the framework artifact store. Both paths record a
 * conformance run over the EXACT published CAS digest (proof≡effect, trap #7).
 *
 * FAIL-CLOSED: a registry resolution failure for an unregistered target is LOUD
 * (`DesignAdapterNotRegisteredError`); a receipt that fails the positive-only
 * predicate is recorded as `failed`, never as `passed`.
 */
export async function composeTargetOutcome(
  deps: ComposeProjectTargetDesignSystemsDeps,
  adapterSet: DesignTargetAdapterSet,
  input: {
    readonly target: DesignAdapterConformanceTarget;
    readonly requiredCapabilities: readonly string[];
    readonly context: TargetCompositionContext;
    readonly conformanceStore: DesignAdapterConformanceStore;
  },
): Promise<ComposeTargetOutcomeResult> {
  const { target, context, conformanceStore } = input;
  if (target === WEB_DESIGN_TARGET) {
    const web = await publishWebTarget(deps, adapterSet, context);
    const webRun = await recordWebConformanceRun(conformanceStore, adapterSet.web, {
      orgId: context.orgId,
      projectId: context.projectId,
      releaseId: context.releaseId,
      artifactId: web.artifactId,
      artifactDigest: web.artifactDigest,
      adapterVersion: "tanren.web-react.v1",
      requiredCapabilities: input.requiredCapabilities,
    });
    return {
      target: WEB_DESIGN_TARGET,
      artifactId: web.artifactId,
      artifactDigest: web.artifactDigest,
      conformanceRunId: webRun.id,
      conformanceOutcome: webRun.outcome,
      canonicalForRelease: true,
    };
  }
  // Non-web target: the registry resolution is LOUD on an unregistered target.
  adapterSet.registry.resolve(target);
  const frameworkAdapter: FrameworkDesignTargetAdapter = resolveFrameworkAdapter(adapterSet, target);
  const frameworkArtifactId = newTargetArtifactId(target);
  const artifact = buildFrameworkArtifact(frameworkAdapter, {
    artifactId: frameworkArtifactId,
    releaseId: context.releaseId,
    target,
    contractDigest: context.contractDigest,
    plainReleaseDigest: context.plainReleaseDigest,
    polishedReleaseDigest: context.polishedReleaseDigest,
    fragmentLineage: context.fragmentLineage,
  });
  const manifestBytes = encodeFrameworkManifest(artifact);
  const { artifactDigest } = await persistFrameworkDesignArtifact({
    pool: deps.pool,
    artifactStore: deps.artifactStore,
    orgId: context.orgId,
    projectId: context.projectId,
    designSystemId: context.designSystemId,
    artifact,
    manifestBytes,
  });
  const receipt = await recordFrameworkConformanceRun(frameworkAdapter, {
    artifactDigest,
    adapterVersion: `tanren.${target}.v1`,
  });
  const persisted = await conformanceStore.record({
    orgId: context.orgId,
    projectId: context.projectId,
    id: newConformanceRunId(target),
    releaseId: context.releaseId,
    artifactId: frameworkArtifactId,
    target,
    adapterVersion: `tanren.${target}.v1`,
    artifactDigest,
    receipt,
  });
  return {
    target,
    artifactId: frameworkArtifactId,
    artifactDigest,
    conformanceRunId: persisted.id,
    conformanceOutcome: persisted.outcome,
    canonicalForRelease: false,
  };
}
