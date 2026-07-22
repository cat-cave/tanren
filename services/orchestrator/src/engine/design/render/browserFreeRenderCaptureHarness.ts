// ds-4 sub-node #1 — the concrete browser-free render/capture harness.
//
// Slice A of the A4 visual-verification chain: render a real catalog component
// (React SSR), audit it (jsdom + axe-core), and store the REAL capture bytes
// (DOM snapshot + a11y audit JSON) content-addressed via the org-scoped
// `CasByteStore`, keyed to the scenario + design-contract version. This is the
// producer sub-nodes #2 (verdict oracle), #3 (gate wiring), and #4 (negative
// controls) consume — it issues NO verdict and wires NO gate itself.
//
// Fail-closed contract: a component that will not bundle/render, or renders to
// an empty/blank DOM, yields an explicit `render_failed` result — NEVER a silent
// empty capture treated as success. (That failure path is the seam #4's negative
// controls exercise.)

import type { CasByteStore } from "../../contracts/cas.js";
import { contentDigestOf } from "../../contracts/cas.js";
import type { EvidenceBytePayload } from "../../contracts/runtimeVerificationAdapters.js";
import type { EventStore } from "../../eventStore.js";
import { captureDomA11y, type DomA11yCapture } from "./domA11yAudit.js";
import { renderComponentToStaticMarkup } from "./componentSsrRenderer.js";
import type { RenderCaptureOutcome, RenderCaptureRef, RenderCaptureRequest } from "./renderCaptureContracts.js";

const DOM_MEDIA_TYPE = "text/html; charset=utf-8";
const A11Y_MEDIA_TYPE = "application/json";
const encoder = new TextEncoder();

/**
 * The browser-free `RenderCaptureAdapter` implementation for Slice A. It is
 * constructed with the sole SP-3 `CasByteStore` (org-scoped) so every capture is
 * content-addressed through the one proof substrate.
 *
 * SEAM — the render-worker (browser) sub-node adds pixel screenshots by
 * implementing the same store-to-CAS shape with a `RenderEvidenceKind` of
 * `"screenshot"`; this harness deliberately omits pixels.
 */
export class BrowserFreeRenderCaptureHarness {
  public constructor(
    private readonly cas: CasByteStore,
    private readonly events?: EventStore,
  ) {}

  public async capture(request: RenderCaptureRequest): Promise<RenderCaptureOutcome> {
    const { scenario, designContractVersion } = request;
    const rendered = await renderComponentToStaticMarkup({
      componentSource: request.componentSource,
      componentExportName: request.componentExportName,
      props: request.renderProps ?? {},
      children: request.children,
    });
    if (!rendered.ok) {
      return {
        kind: "render_failed",
        scenarioKey: scenario.scenarioKey,
        designContractVersion,
        stage: rendered.stage,
        reason: rendered.reason,
      };
    }
    if (!containsElement(rendered.html)) {
      return {
        kind: "render_failed",
        scenarioKey: scenario.scenarioKey,
        designContractVersion,
        stage: "empty_render",
        reason: "component rendered to an empty/blank DOM (no element markup)",
      };
    }

    const capture = await captureDomA11y(rendered.html, scenario);
    const domRef = await this.store(request.orgId, encoder.encode(capture.documentHtml), DOM_MEDIA_TYPE);
    const a11yBytes = encoder.encode(serializeAudit(capture, designContractVersion));
    const a11yRef = await this.store(request.orgId, a11yBytes, A11Y_MEDIA_TYPE);

    const captureRefs: readonly RenderCaptureRef[] = [
      { kind: "dom_snapshot", evidenceKind: "dom", casRef: domRef },
      { kind: "a11y_audit", evidenceKind: "a11y_tree", casRef: a11yRef },
    ];
    if (this.events === undefined || request.projectId === undefined) {
      throw new Error("design render capture completed without its required event sink or project id");
    }
    {
      const renderId = contentDigestOf(
        encoder.encode(JSON.stringify([scenario.scenarioKey, designContractVersion, domRef.digest, a11yRef.digest])),
      );
      await this.events.append({
        orgId: request.orgId,
        projectId: request.projectId,
        eventType: "design.render.captured",
        payload: {
          renderId,
          artifactDigest: a11yRef.digest,
          scenarioKey: scenario.scenarioKey,
          designContractVersion,
          a11yViolationCount: capture.audit.violationCount,
        },
      });
    }
    return {
      kind: "captured",
      scenarioKey: scenario.scenarioKey,
      designContractVersion,
      captureRefs,
      a11y: {
        engine: capture.audit.engine,
        engineVersion: capture.audit.engineVersion,
        violationCount: capture.audit.violationCount,
        passCount: capture.audit.passCount,
        incompleteCount: capture.audit.incompleteCount,
        domElementCount: capture.audit.dom.elementCount,
        roles: capture.audit.dom.roles,
      },
    };
  }

  /**
   * Build the SP-5 `EvidenceBytePayload[]` (dom + a11y_tree) for a captured
   * result — the raw byte currency the verdict oracle (sub-node #2) links. Kept
   * separate from `capture` so the oracle can request payloads without re-render.
   */
  public toEvidencePayloads(capture: DomA11yCapture, designContractVersion: string): readonly EvidenceBytePayload[] {
    return [
      { kind: "dom", mediaType: DOM_MEDIA_TYPE, bytes: encoder.encode(capture.documentHtml), redactionClass: "none" },
      {
        kind: "a11y_tree",
        mediaType: A11Y_MEDIA_TYPE,
        bytes: encoder.encode(serializeAudit(capture, designContractVersion)),
        redactionClass: "none",
      },
    ];
  }

  private async store(orgId: string, bytes: Uint8Array, mediaType: string): Promise<CasArtifactRefLike> {
    return this.cas.put({ orgId, bytes, mediaType });
  }
}

type CasArtifactRefLike = Awaited<ReturnType<CasByteStore["put"]>>;

/** A real render must produce element markup — a bare/empty string never counts as success. */
function containsElement(html: string): boolean {
  return /<[a-z][\s\S]*?>/iu.test(html.trim());
}

function serializeAudit(capture: DomA11yCapture, designContractVersion: string): string {
  return `${JSON.stringify({ designContractVersion, ...capture.audit }, null, 2)}\n`;
}
