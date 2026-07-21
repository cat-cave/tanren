// ds-7 — the production `DesignTargetAdapterRegistry` factory. Registers every
// framework adapter the engine supports (web-react + generic-web + Bevy + SwiftUI
// + Jetpack Compose + Flutter + React Native + document-media) against the SAME
// frozen `DesignTargetAdapter` contract. Resolving an unregistered target is a
// LOUD `DesignAdapterNotRegisteredError` — never a stub render.
//
// This factory REPLACES the closed `WebDesignTargetAdapter` construction in
// `composeProjectWebDesignSystem`. The composer now resolves each required V2
// target profile through this registry; `web-react` is a REGISTERED impl, never
// a fallback for another target.

import type { DtcgResolution } from "./dtcgResolver.js";
import { WebDesignTargetAdapter } from "./webAdapter.js";
import { DesignTargetAdapterRegistry } from "./designTargetAdapter.js";
import { buildBevyAdapter, type BevyDesignTargetAdapter } from "./bevyAdapter.js";
import { buildDocumentMediaAdapter, type DocumentMediaDesignTargetAdapter } from "./documentMediaAdapter.js";
import { buildFlutterAdapter, type FlutterDesignTargetAdapter } from "./flutterAdapter.js";
import { buildGenericWebAdapter, type GenericWebDesignTargetAdapter } from "./genericWebAdapter.js";
import { buildJetpackComposeAdapter, type JetpackComposeDesignTargetAdapter } from "./jetpackComposeAdapter.js";
import { buildReactNativeAdapter, type ReactNativeDesignTargetAdapter } from "./reactNativeAdapter.js";
import { buildSwiftUiAdapter, type SwiftUIFrameworkDesignTargetAdapter } from "./swiftUiAdapter.js";

/**
 * The set of framework adapters the engine supports. The web adapter is a
 * concrete class (it has the rich ds-2 projection: catalog, exports, writer
 * context); the non-web adapters share the ds-7 framework core.
 */
export interface DesignTargetAdapterSet {
  readonly registry: DesignTargetAdapterRegistry;
  /** Direct handles the composer uses to build/publish per-target artifacts. */
  readonly web: WebDesignTargetAdapter;
  readonly bevy: BevyDesignTargetAdapter;
  readonly swiftUi: SwiftUIFrameworkDesignTargetAdapter;
  readonly jetpackCompose: JetpackComposeDesignTargetAdapter;
  readonly flutter: FlutterDesignTargetAdapter;
  readonly reactNative: ReactNativeDesignTargetAdapter;
  readonly genericWeb: GenericWebDesignTargetAdapter;
  readonly documentMedia: DocumentMediaDesignTargetAdapter;
}

/**
 * Build the production adapter set. Each adapter is constructed against the
 * SAME resolved DTCG token set the web adapter uses, so a multi-target
 * composition projects ONE design language onto every target. The registry
 * rejects a duplicate registration loudly (a wiring bug, never a silent
 * shadow).
 */
export function buildDesignTargetAdapterSet(
  webDesignSystem: { readonly designSystemId: string; readonly releaseId: string; readonly tokens: DtcgResolution },
  plainBaseTokens: Readonly<Record<string, unknown>>,
): DesignTargetAdapterSet {
  const web = new WebDesignTargetAdapter(webDesignSystem);
  const bevy = buildBevyAdapter(plainBaseTokens);
  const swiftUi = buildSwiftUiAdapter(plainBaseTokens);
  const jetpackCompose = buildJetpackComposeAdapter(plainBaseTokens);
  const flutter = buildFlutterAdapter(plainBaseTokens);
  const reactNative = buildReactNativeAdapter(plainBaseTokens);
  const genericWeb = buildGenericWebAdapter(plainBaseTokens);
  const documentMedia = buildDocumentMediaAdapter(plainBaseTokens);
  const registry = new DesignTargetAdapterRegistry();
  registry.register(web);
  registry.register(bevy);
  registry.register(swiftUi);
  registry.register(jetpackCompose);
  registry.register(flutter);
  registry.register(reactNative);
  registry.register(genericWeb);
  registry.register(documentMedia);
  return { registry, web, bevy, swiftUi, jetpackCompose, flutter, reactNative, genericWeb, documentMedia };
}
