// ds-4 sub-node #1 — proves the browser-free render/capture harness renders a
// REAL ds-2 catalog component (React SSR) and stores REAL capture bytes (DOM +
// a11y audit) in a real CAS store — plus the fail-closed render-failure seam
// (the negative-control seam sub-node #4 consumes). No stub captures.

import { describe, expect, it } from "vitest";
import {
  contentDigestOf,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { DesignRenderScenario } from "../src/engine/design/system/designTargetAdapter.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";
import { WebDesignTargetAdapter } from "../src/engine/design/system/webAdapter.js";
import { BrowserFreeRenderCaptureHarness } from "../src/engine/design/render/browserFreeRenderCaptureHarness.js";

// A real org-scoped CasByteStore backed by memory: content-addressed, same seam
// PgCasByteStore implements. The bytes it stores are REAL harness output.
class InMemoryContentStore implements CasByteStore {
  readonly rows = new Map<Digest, CasArtifactBytes>();
  async put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    this.rows.set(digest, { digest, bytes: input.bytes, mediaType: input.mediaType });
    return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }
  async get(_orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = this.rows.get(digest);
    if (row === undefined) throw new Error(`missing CAS row ${digest}`);
    return row;
  }
  async has(_orgId: string, digest: Digest): Promise<boolean> {
    return this.rows.has(digest);
  }
}

const ORG_ID = "org_ds4";
const DESIGN_CONTRACT_VERSION = "dcv_1";

function realCatalogAdapter(): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({
    designSystemId: "system_web",
    releaseId: "release_web_1",
    tokens: resolveDtcgTokens({
      color: {
        background: { $type: "color", $value: "#ffffff" },
        border: { $type: "color", $value: "#d0d5dd" },
        foreground: { $type: "color", $value: "#101828" },
        primary: { $type: "color", $value: "#155eef" },
      },
      radius: { md: { $type: "dimension", $value: "0.375rem" } },
      space: { md: { $type: "dimension", $value: "0.5rem" } },
    }),
  });
}

function realButtonSource(): string {
  const artifact = realCatalogAdapter().buildArtifact({
    artifactId: "artifact_web_1",
    contractDigest: `sha256:${"a".repeat(64)}`,
    plainReleaseDigest: `sha256:${"b".repeat(64)}`,
    polishedReleaseDigest: `sha256:${"c".repeat(64)}`,
    fragmentLineage: [],
  });
  const buttonFile = artifact.files.find((file) => file.path === "components/ui/button.tsx");
  if (buttonFile === undefined) throw new Error("real catalog is missing the button source");
  return new TextDecoder().decode(buttonFile.bytes);
}

async function firstButtonScenario(): Promise<DesignRenderScenario> {
  const adapter = realCatalogAdapter();
  const profile = { target: "web-react", capabilities: ["css-variables", "tailwind", "catalog", "exports"] };
  const vfs = await adapter.materialize([], await adapter.bootstrapPlainSystem(profile));
  const matrix = await adapter.renderScenarioMatrix(vfs, profile);
  const scenario = matrix.find((entry) => entry.component === "button");
  if (scenario === undefined) throw new Error("real render matrix has no button scenario");
  return scenario;
}

describe("BrowserFreeRenderCaptureHarness", () => {
  it("renders the REAL ds-2 Button via React SSR and stores real DOM + a11y capture bytes in CAS", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: realButtonSource(),
      componentExportName: "Button",
      designContractVersion: DESIGN_CONTRACT_VERSION,
      renderProps: { type: "button", "aria-label": "primary action" },
      children: "Click me",
    });

    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    expect(outcome.scenarioKey).toBe(scenario.scenarioKey);
    expect(outcome.designContractVersion).toBe(DESIGN_CONTRACT_VERSION);

    // Two real captures landed in CAS: a DOM snapshot and an a11y audit.
    const domRef = outcome.captureRefs.find((ref) => ref.kind === "dom_snapshot");
    const a11yRef = outcome.captureRefs.find((ref) => ref.kind === "a11y_audit");
    expect(domRef?.evidenceKind).toBe("dom");
    expect(a11yRef?.evidenceKind).toBe("a11y_tree");
    if (domRef === undefined || a11yRef === undefined) return;

    // The DOM bytes are REAL: a rendered <button> from the real Button component.
    const domBytes = await cas.get(ORG_ID, domRef.casRef.digest);
    const domHtml = new TextDecoder().decode(domBytes.bytes);
    expect(domBytes.bytes.byteLength).toBeGreaterThan(0);
    expect(domHtml).toContain("<button");
    expect(domHtml).toContain("Click me");
    expect(domHtml).toContain('aria-label="primary action"');
    // Scenario metadata is applied to the captured document.
    expect(domHtml).toContain(`data-theme="${scenario.theme}"`);
    expect(domHtml).toContain(`lang="${scenario.locale}"`);
    // The CAS digest is a real content digest of the stored bytes.
    expect(domRef.casRef.digest).toBe(contentDigestOf(domBytes.bytes));

    // The a11y bytes are a REAL axe audit that actually ran over the DOM.
    const a11yBytes = await cas.get(ORG_ID, a11yRef.casRef.digest);
    const audit = JSON.parse(new TextDecoder().decode(a11yBytes.bytes)) as Record<string, unknown>;
    expect(a11yBytes.bytes.byteLength).toBeGreaterThan(0);
    expect(audit.engine).toBe("axe-core");
    expect(typeof audit.engineVersion).toBe("string");
    expect(Array.isArray(audit.violations)).toBe(true);
    expect(audit.designContractVersion).toBe(DESIGN_CONTRACT_VERSION);
    const dom = audit.dom as { elementCount: number; tagInventory: Record<string, number> };
    expect(dom.elementCount).toBeGreaterThan(0);
    expect(dom.tagInventory.button).toBeGreaterThanOrEqual(1);

    expect(outcome.a11y.engine).toBe("axe-core");
    expect(outcome.a11y.domElementCount).toBeGreaterThan(0);
  });

  it("FAIL-CLOSED: a component that cannot bundle → render_failed(bundle), never a blank capture", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const scenario = await firstButtonScenario();

    const broken = [
      'import { DoesNotExist } from "@tanren/definitely-not-a-real-package";',
      "export const Broken = () => DoesNotExist();",
      "",
    ].join("\n");
    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: broken,
      componentExportName: "Broken",
      designContractVersion: DESIGN_CONTRACT_VERSION,
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("bundle");
    expect(outcome.reason.length).toBeGreaterThan(0);
    // Fail-closed: nothing was written to CAS.
    expect(cas.rows.size).toBe(0);
  });

  it("FAIL-CLOSED: a component that throws while rendering → render_failed(render)", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const scenario = await firstButtonScenario();

    const thrower = [
      'import * as React from "react";',
      'export const Boom = () => { throw new Error("render blew up"); };',
      "",
    ].join("\n");
    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: thrower,
      componentExportName: "Boom",
      designContractVersion: DESIGN_CONTRACT_VERSION,
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("render");
    expect(cas.rows.size).toBe(0);
  });

  it("FAIL-CLOSED: a component that renders nothing → render_failed(empty_render)", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const scenario = await firstButtonScenario();

    const empty = ['import * as React from "react";', "export const Empty = () => null;", ""].join("\n");
    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: empty,
      componentExportName: "Empty",
      designContractVersion: DESIGN_CONTRACT_VERSION,
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("empty_render");
    expect(cas.rows.size).toBe(0);
  });
});
