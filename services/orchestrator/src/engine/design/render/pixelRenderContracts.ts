// ds-4 Slice B — the pixel render-worker contracts.
//
// Slice A is browser-FREE (React SSR → jsdom → axe): it captures DOM + a11y and
// never touches pixels. Slice B adds the REAL pixel path — a containerized
// (podman + Playwright) browser screenshots the rendered scenario and the raw PNG
// bytes are stored content-addressed via the org-scoped `CasByteStore` under the
// `screenshot` `RenderEvidenceKind`. This is the producer the visual-diff oracle
// (`visualDiffOracle.ts`) consumes; it issues NO verdict and wires NO gate itself.
//
// Fail-closed contract: a component that will not bundle/render, or renders to an
// empty/blank DOM, or whose containerized browser fails to produce a real PNG,
// yields an explicit `render_failed` result — NEVER a blank/empty screenshot
// treated as success. Absence is never a pass.

import type { CasArtifactRef } from "../../contracts/cas.js";
import type { DesignRenderScenario } from "../system/designTargetAdapter.js";

/** The component + scenario to screenshot. `componentSource` is the REAL catalog TSX. */
export interface PixelCaptureRequest {
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

/** Where a fail-closed pixel-capture failure occurred. NEVER a silent blank screenshot. */
export type PixelFailureStage = "bundle" | "render" | "empty_render" | "browser";

/** Concrete browser viewport dimensions the screenshot was taken at. */
export interface PixelViewport {
  readonly width: number;
  readonly height: number;
}

/** The stored screenshot, content-addressed in CAS + tagged with the `screenshot` kind. */
export interface PixelCaptureRef {
  readonly kind: "screenshot";
  readonly evidenceKind: "screenshot";
  readonly casRef: CasArtifactRef;
  readonly viewport: PixelViewport;
}

export interface PixelCapturedResult {
  readonly kind: "pixel_captured";
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  readonly captureRef: PixelCaptureRef;
  /** The real PNG byte size (a screenshot is never zero-length under a pass). */
  readonly byteSize: number;
}

export interface PixelRenderFailedResult {
  readonly kind: "render_failed";
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  readonly stage: PixelFailureStage;
  readonly reason: string;
}

/** Fail-closed: a scenario that cannot bundle/render/screenshot → an explicit failure. */
export type PixelCaptureOutcome = PixelCapturedResult | PixelRenderFailedResult;

/** A real containerized screenshot: raw PNG bytes taken at the requested viewport. */
export interface PixelScreenshotResult {
  readonly ok: true;
  readonly png: Uint8Array;
  readonly viewport: PixelViewport;
}

/** Fail-closed: the container/browser failed to produce a real PNG (never a blank pass). */
export interface PixelScreenshotFailure {
  readonly ok: false;
  readonly reason: string;
}

/**
 * The browser seam. A real implementation ({@link ../render/podmanScreenshotRunner})
 * runs a containerized Playwright chromium via podman; tests inject a double that
 * returns REAL PNG bytes (from fixtures) so the harness + diff logic are unit-tested
 * without a live browser, while the container path stays real and env-gated.
 */
export interface PixelRenderRunner {
  screenshot(input: {
    readonly documentHtml: string;
    readonly viewport: PixelViewport;
    /**
     * The scenario's BCP-47 locale, DECLARED to the browser (Playwright's
     * `newPage({ locale })`) rather than inherited from the host.
     *
     * REQUIRED, not optional, on purpose: `locale` is a dimension of the scenario
     * matrix and outcomes are keyed on it, but the scenario document only ever
     * stamped it into `<html lang>` — a markup attribute that does NOT set
     * `navigator.language`. Every scenario therefore rendered in whatever locale the
     * host supplied, so the matrix dimension was inert with respect to the thing it
     * claims to vary. Making this required means a new call site cannot silently
     * reintroduce host inheritance; the compiler asks for the locale.
     */
    readonly locale: string;
  }): Promise<PixelScreenshotResult | PixelScreenshotFailure>;
}

/** The 8-byte PNG signature. A real screenshot ALWAYS starts with it. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when `bytes` is a non-trivial, real PNG (signature + more than the header). */
export function isRealPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
