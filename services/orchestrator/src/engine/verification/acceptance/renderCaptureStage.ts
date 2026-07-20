/**
 * rv-9 render-capture stage: the seam the A1 acceptance run invokes to turn a
 * drive's raw evidence bytes (rv-6 HTTP response captures, render output) into
 * content-addressed {@link EvidenceLinkRef}s.
 *
 * It is a THIN orchestration over {@link VerificationCaptureStore}: each captured
 * payload is content-addressed + persisted; the returned refs let the verdict
 * carry immutable, digest-addressed evidence. Fail-closed by construction — a
 * capture that cannot be hashed/stored throws out of the store and aborts the
 * behavior (never recorded as a valid artifact). This stage is INVOKED per
 * behavior in {@link AcceptanceOrchestrator}; it is not a standalone dead path.
 */

import type { EvidenceBytePayload, EvidenceLinkRef } from "../../contracts/runtimeVerificationAdapters.js";
import type { VerificationCaptureStore } from "./renderCaptureStore.js";

export interface RenderCaptureStageInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly payloads: readonly EvidenceBytePayload[];
}

export class RenderCaptureStage {
  public constructor(private readonly store: VerificationCaptureStore) {}

  /**
   * Content-address every captured payload and return an EvidenceLinkRef per
   * stored artifact. Identical content of the same kind dedupes to one address,
   * so re-running a behavior over an unchanged response reuses the artifact.
   */
  public async capture(input: RenderCaptureStageInput): Promise<readonly EvidenceLinkRef[]> {
    const refs: EvidenceLinkRef[] = [];
    for (const payload of input.payloads) {
      const stored = await this.store.capture({
        orgId: input.orgId,
        projectId: input.projectId,
        kind: renderEvidenceKindToArtifactKind(payload.kind),
        mediaType: payload.mediaType,
        bytes: payload.bytes,
        redactionClass: payload.redactionClass,
      });
      refs.push({
        verificationArtifactId: stored.verificationArtifactId,
        casDigest: stored.casDigest,
        mediaType: stored.mediaType,
      });
    }
    return refs;
  }
}

/**
 * Map an SP-5 render-evidence kind to the persisted `verification_artifacts.kind`
 * tag. An HTTP response capture rides the `network` evidence kind; the rest keep
 * their render-flavored names.
 */
export function renderEvidenceKindToArtifactKind(kind: EvidenceBytePayload["kind"]): string {
  return kind === "network" ? "response_capture" : `render_${kind}`;
}
