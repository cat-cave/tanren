// ds-4 sub-node #1 — the design-system render/capture harness contracts.
//
// Slice A is browser-FREE: it renders a real catalog component via React SSR
// (`react-dom/server` `renderToStaticMarkup`) into a jsdom DOM and runs a real
// `axe-core` a11y audit — no browser, so it runs in ordinary Node/CI on the
// NixOS host where a prebuilt chromium will not launch. The captured bytes (the
// rendered DOM snapshot + the a11y audit JSON) are stored content-addressed via
// the org-scoped `CasByteStore`, keyed to the scenario + design-contract version.
//
// SEAMS (NOT built here — later ds-4 sub-nodes consume these captures):
//   #2 verdict oracle       — reads the stored a11y/DOM bytes + issues a verdict.
//   #3 design_render gate    — wires captures into the native gate proof units.
//   #4 negative controls     — exercises the fail-closed `render_failed` seam.
// PIXEL screenshots are OUT OF SCOPE — that is the separate render-worker
// sub-node (a real browser). This slice deliberately captures DOM + a11y only.

import type { RenderEvidenceKind } from "../../contracts/runtimeVerificationAdapters.js";
import type { CasArtifactRef } from "../../contracts/cas.js";
import type { DesignRenderScenario } from "../system/designTargetAdapter.js";

/** The component + scenario to render. `componentSource` is the REAL catalog TSX. */
export interface RenderCaptureRequest {
  readonly orgId: string;
  readonly scenario: DesignRenderScenario;
  /** The catalog component's real TSX source (e.g. `webCatalog` `components/ui/button.tsx`). */
  readonly componentSource: string;
  /** The named export to render from `componentSource` (e.g. `"Button"`). */
  readonly componentExportName: string;
  /** The design-contract version this capture is keyed to (part of the CAS provenance). */
  readonly designContractVersion: string;
  /** Props passed to the rendered element (defaults to `{}`). */
  readonly renderProps?: Readonly<Record<string, unknown>>;
  /** Plain-text children for the rendered element (e.g. a Button label). */
  readonly children?: string;
}

/** Where a fail-closed render failure occurred. NEVER a silent empty/blank capture. */
export type RenderFailureStage = "bundle" | "render" | "empty_render";

/** One stored capture, content-addressed in CAS + tagged with the evidence kind. */
export interface RenderCaptureRef {
  readonly kind: "dom_snapshot" | "a11y_audit";
  readonly evidenceKind: RenderEvidenceKind;
  readonly casRef: CasArtifactRef;
}

/** The a11y audit summary embedded in the stored `a11y_audit` bytes + returned inline. */
export interface RenderA11ySummary {
  readonly engine: string;
  readonly engineVersion: string;
  readonly violationCount: number;
  readonly passCount: number;
  readonly incompleteCount: number;
  readonly domElementCount: number;
  readonly roles: readonly string[];
}

export interface RenderCapturedResult {
  readonly kind: "captured";
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  readonly captureRefs: readonly RenderCaptureRef[];
  readonly a11y: RenderA11ySummary;
}

export interface RenderFailedResult {
  readonly kind: "render_failed";
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  readonly stage: RenderFailureStage;
  readonly reason: string;
}

/** Fail-closed: a scenario that cannot bundle/render → an explicit failure, never a blank success. */
export type RenderCaptureOutcome = RenderCapturedResult | RenderFailedResult;
