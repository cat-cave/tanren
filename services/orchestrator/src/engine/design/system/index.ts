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
export * from "./designStudioStore.js";
export * from "./designEcosystemContracts.js";
export * from "./designEcosystemService.js";
export * from "./designEcosystemReadStore.js";
export * from "./designEcosystemExternalBridge.js";
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
export * from "./composeProjectTargetDesignSystems.js";
// ds-7 — multi-target framework reach: the frozen conformance receipt, the
// per-target framework adapter core + concrete adapters (Bevy/SwiftUI/Compose/
// Flutter/RN/generic-web/document-media), the production adapter set, the
// framework artifact persistence + conformance-run store, and the helpers that
// keep the multi-target composer under the 500-line cap.
export * from "./adapterConformanceReceipt.js";
export * from "./adapterConformanceStore.js";
export * from "./frameworkAdapterCore.js";
export * from "./bevyAdapter.js";
export * from "./swiftUiAdapter.js";
export * from "./jetpackComposeAdapter.js";
export * from "./flutterAdapter.js";
export * from "./reactNativeAdapter.js";
export * from "./genericWebAdapter.js";
export * from "./documentMediaAdapter.js";
export * from "./designTargetRegistry.js";
export * from "./frameworkArtifactPersistence.js";
// ds-3 (F2D) — the design-fragment authoring loop (selector → author → check →
// atomic persist / retract) on the shared SP-2 kernel. Reachable from the design
// public surface so the composition/curation trigger (see the ds-3 blocker note)
// can construct + invoke it once a real design-fragment need is produced.
export * from "./authoring/index.js";
