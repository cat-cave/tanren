// ds-1 — the pure event seam for executable design-system core operations.
//
// The EventStore owns persistence and schema parsing. The token core stays
// deterministic by returning through this injected, synchronous seam; a workflow
// can bridge it to its org-scoped EventStore append closure without teaching the
// resolver or validator about Postgres.

export interface DesignSystemBaseComposedEvent {
  readonly curationId: string;
  readonly plainArtifactDigest: string;
  readonly catalogBuildDigest: string;
  readonly tokenResolutionDigest: string;
}

export interface DesignSystemArtifactValidatedEvent {
  readonly releaseId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly validationRunId: string;
  readonly expectedMatrixDigest: string;
}

export type DesignSystemCoreEvent =
  | { readonly type: "designSystem.base.composed"; readonly payload: DesignSystemBaseComposedEvent }
  | { readonly type: "designSystem.artifact.validated"; readonly payload: DesignSystemArtifactValidatedEvent };

/** A synchronous boundary the engine can adapt to its existing EventStore append seam. */
export interface DesignSystemCoreEventEmitter {
  emit(event: DesignSystemCoreEvent): void;
}
