// ds-4 Slice B sub-node #1 — the concrete PIXEL render/capture harness.
//
// The pixel counterpart of `browserFreeRenderCaptureHarness.ts`: it renders a real
// ds-2 catalog component (React SSR — reusing the Slice-A bundler), wraps it in the
// SHARED scenario document (theme/viewport/locale), screenshots it in a
// containerized Playwright chromium (the injected `PixelRenderRunner`), and stores
// the REAL PNG bytes content-addressed via the org-scoped `CasByteStore` under the
// `screenshot` `RenderEvidenceKind`. It issues NO verdict and wires NO gate — the
// visual-diff oracle (`visualDiffOracle.ts`) consumes the stored screenshot.
//
// Fail-closed: a component that will not bundle/render → `render_failed(bundle|render)`;
// an empty/blank DOM → `render_failed(empty_render)`; a container/browser failure or a
// non-PNG/trivial screenshot → `render_failed(browser)`. A blank screenshot is NEVER
// treated as a pass, and NOTHING is written to CAS on failure.

import type { CasByteStore } from "../../contracts/cas.js";
import type { EvidenceBytePayload } from "../../contracts/runtimeVerificationAdapters.js";
import { renderComponentToStaticMarkup } from "./componentSsrRenderer.js";
import { resolveViewport, scenarioDocument } from "./domA11yAudit.js";
import {
  isRealPng,
  type PixelCaptureOutcome,
  type PixelCaptureRequest,
  type PixelRenderRunner,
} from "./pixelRenderContracts.js";

const SCREENSHOT_MEDIA_TYPE = "image/png";

/**
 * The pixel `RenderCaptureAdapter` implementation for Slice B. Constructed with the
 * sole SP-3 `CasByteStore` (org-scoped) + the browser seam so every screenshot is
 * content-addressed through the one proof substrate and the browser is swappable
 * (real podman container in prod; a fixture-PNG double in unit tests).
 */
export class PixelRenderCaptureHarness {
  public constructor(
    private readonly cas: CasByteStore,
    private readonly runner: PixelRenderRunner,
  ) {}

  public async capture(request: PixelCaptureRequest): Promise<PixelCaptureOutcome> {
    const { scenario, designContractVersion } = request;

    const rendered = await renderComponentToStaticMarkup({
      componentSource: request.componentSource,
      componentExportName: request.componentExportName,
      props: request.renderProps ?? {},
      children: request.children,
    });
    if (!rendered.ok) {
      return this.failed(scenario.scenarioKey, designContractVersion, rendered.stage, rendered.reason);
    }
    if (!containsElement(rendered.html)) {
      return this.failed(
        scenario.scenarioKey,
        designContractVersion,
        "empty_render",
        "component rendered to an empty/blank DOM (no element markup)",
      );
    }

    const documentHtml = scenarioDocument(rendered.html, scenario);
    const viewport = resolveViewport(scenario.viewport);
    const shot = await this.runner.screenshot({ documentHtml, viewport });
    if (!shot.ok) {
      return this.failed(scenario.scenarioKey, designContractVersion, "browser", shot.reason);
    }
    // Defense in depth: the runner already validates the PNG, but the harness never
    // stores bytes it has not itself confirmed are a real, non-trivial screenshot.
    if (!isRealPng(shot.png)) {
      return this.failed(
        scenario.scenarioKey,
        designContractVersion,
        "browser",
        `screenshot bytes are not a real PNG (byteLength=${shot.png.byteLength})`,
      );
    }

    const casRef = await this.cas.put({ orgId: request.orgId, bytes: shot.png, mediaType: SCREENSHOT_MEDIA_TYPE });
    return {
      kind: "pixel_captured",
      scenarioKey: scenario.scenarioKey,
      designContractVersion,
      captureRef: { kind: "screenshot", evidenceKind: "screenshot", casRef, viewport: shot.viewport },
      byteSize: casRef.byteSize,
    };
  }

  /**
   * Build the SP-5 `EvidenceBytePayload` (screenshot) for a captured result — the raw
   * byte currency the verdict oracle links. Reads the stored bytes back from CAS so
   * the payload is the EXACT content-addressed screenshot (never a re-render).
   */
  public async toEvidencePayload(capture: PixelCaptureOutcome, orgId: string): Promise<EvidenceBytePayload | null> {
    if (capture.kind !== "pixel_captured") return null;
    const bytes = await this.cas.get(orgId, capture.captureRef.casRef.digest);
    return { kind: "screenshot", mediaType: SCREENSHOT_MEDIA_TYPE, bytes: bytes.bytes, redactionClass: "none" };
  }

  private failed(
    scenarioKey: string,
    designContractVersion: string,
    stage: "bundle" | "render" | "empty_render" | "browser",
    reason: string,
  ): PixelCaptureOutcome {
    return { kind: "render_failed", scenarioKey, designContractVersion, stage, reason };
  }
}

/** A real render must produce element markup — a bare/empty string never counts as success. */
function containsElement(html: string): boolean {
  return /<[a-z][\s\S]*?>/iu.test(html.trim());
}
