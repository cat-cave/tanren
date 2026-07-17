// ds-0 — the executable-design-system FOUNDATION public surface.
//
// The typed contracts + seams ds-1..8 build against: DesignContractV2 (intent),
// the artifact/release/fragment schemas, the DesignTargetAdapter contract +
// registry, the proof-key derivation, the org-scoped persistence store, and the
// offline foundation validator. The engine bodies (token core, web adapter, F2D,
// A4 gate, dashboard, queue/deploy compounding, framework reach, cross-org
// ecosystem) are ds-1..8 and fill these slots.

export * from "./designContractV2.js";
export * from "./designArtifactSchemas.js";
export * from "./designTargetAdapter.js";
export * from "./designProofKey.js";
export * from "./designSystemStore.js";
export * from "./designFoundationValidator.js";
export * from "./designSystemCoreEvents.js";
export * from "./dtcgResolver.js";
export * from "./designVfs.js";
export * from "./artifactStore.js";
export * from "./dtcgValidator.js";
export * from "./webAdapter.js";
export * from "./webArtifactPersistence.js";
export * from "./webCatalog.js";
export * from "./webExports.js";
export * from "./webTokens.js";
export * from "./webWriterContext.js";
