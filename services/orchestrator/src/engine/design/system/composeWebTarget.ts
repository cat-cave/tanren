// ds-7 — the WEB-REACT target handling extracted from the multi-target composer.
// The web target is special: it uses the rich ds-2 adapter (catalog + exports +
// writer context), is the canonical release artifact, runs the ds-4 design-render
// verify, AND records a conformance receipt over its published manifest. Keeping
// the web handling in its own module keeps the multi-target composer under the
// 500-line cap while preserving the carefully-tested web flow.

import { randomUUID } from "node:crypto";
import type { WebDesignTargetAdapter } from "./webAdapter.js";
import type { WebArtifactBuildResult } from "./webAdapter.js";
import { WEB_DESIGN_TARGET } from "./webAdapter.js";
import { type DesignAdapterConformanceStore, type DesignAdapterConformanceRunRow } from "./adapterConformanceStore.js";
import { buildWebConformanceReceipt, newConformanceRunId } from "./composeProjectTargetDesignSystemsHelpers.js";
import type { ComposeProjectTargetDesignSystemsDeps } from "./composeProjectTargetDesignSystems.js";
import type { DesignTargetAdapterSet } from "./designTargetRegistry.js";

/** The shared composition context the per-target loop threads through. */
export interface TargetCompositionContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly contractDigest: string;
  readonly plainReleaseDigest: string;
  readonly polishedReleaseDigest: string;
  readonly fragmentLineage: readonly string[];
}

/** Publish the web-react artifact through the existing web adapter (canonical).
 * Returns the artifactId + the EXACT persisted CAS digest — proof≡effect (trap
 * #7): the conformance receipt's artifactDigest MUST equal this digest, never a
 * recomputed one. */
export async function publishWebTarget(
  deps: ComposeProjectTargetDesignSystemsDeps,
  adapterSet: DesignTargetAdapterSet,
  context: TargetCompositionContext,
): Promise<{ readonly artifactId: string; readonly artifactDigest: string; readonly build: WebArtifactBuildResult }> {
  const artifactId = `design_web_artifact_${randomUUID()}`;
  const persisted = await adapterSet.web.publish({
    artifactId,
    contractDigest: context.contractDigest,
    plainReleaseDigest: context.plainReleaseDigest,
    polishedReleaseDigest: context.polishedReleaseDigest,
    fragmentLineage: context.fragmentLineage,
    pool: deps.pool,
    artifactStore: deps.artifactStore,
    eventStore: deps.eventStore,
    orgId: context.orgId,
    projectId: context.projectId,
  });
  return { artifactId, artifactDigest: persisted.artifactDigest, build: persisted.build };
}

/** Record the web-react conformance run over the EXACT persisted CAS digest
 * (proof≡effect, trap #7). The caller passes the digest returned by
 * `publishWebTarget`; this function never recomputes it. */
export async function recordWebConformanceRun(
  store: DesignAdapterConformanceStore,
  web: WebDesignTargetAdapter,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly artifactId: string;
    /** The EXACT persisted CAS digest `publishWebTarget` returned. */
    readonly artifactDigest: string;
    /** The exact build whose manifest bytes `publishWebTarget` persisted. */
    readonly build: WebArtifactBuildResult;
    readonly adapterVersion: string;
    readonly requiredCapabilities: readonly string[];
  },
): Promise<DesignAdapterConformanceRunRow> {
  const receipt = await buildWebConformanceReceipt({
    web,
    artifactId: input.artifactId,
    artifactDigest: input.artifactDigest,
    build: input.build,
    adapterVersion: input.adapterVersion,
    requiredCapabilities: input.requiredCapabilities,
  });
  return store.record({
    orgId: input.orgId,
    projectId: input.projectId,
    id: newConformanceRunId(WEB_DESIGN_TARGET),
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    target: WEB_DESIGN_TARGET,
    adapterVersion: input.adapterVersion,
    artifactDigest: input.artifactDigest,
    receipt,
  });
}
