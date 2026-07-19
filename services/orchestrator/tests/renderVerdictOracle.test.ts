// ds-4 sub-node #2 — proves the a11y verdict oracle judges REAL axe-core
// violations (produced by driving the sub-node #1 render/capture harness) against
// the project's real `accessibilityPosture`, and is fail-closed on missing /
// unreadable evidence. No stubbed verdicts, no fabricated axe results, no faked
// pixel diff.

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
import type { RenderCaptureOutcome } from "../src/engine/design/render/renderCaptureContracts.js";
import { deriveA11ySeverityBar, RenderA11yVerdictOracle } from "../src/engine/design/render/renderVerdictOracle.js";

// A real org-scoped content store (memory-backed), the same seam PgCasByteStore
// implements. Every byte it holds is REAL harness output.
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

const ORG_ID = "org_ds4_oracle";
const DESIGN_CONTRACT_VERSION = "dcv_oracle_1";

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

// A REAL component with a REAL a11y defect: an <img> with no alt attribute. axe's
// `image-alt` rule fires as a critical-impact violation in jsdom (no layout
// needed). Driven through the real harness → the oracle judges a real axe result.
const IMG_NO_ALT_SOURCE = [
  'import * as React from "react";',
  'export const NoAltImage = () => React.createElement("img", { src: "logo.png" });',
  "",
].join("\n");

async function captureButton(harness: BrowserFreeRenderCaptureHarness): Promise<RenderCaptureOutcome> {
  return harness.capture({
    orgId: ORG_ID,
    scenario: await firstButtonScenario(),
    componentSource: realButtonSource(),
    componentExportName: "Button",
    designContractVersion: DESIGN_CONTRACT_VERSION,
    renderProps: { type: "button", "aria-label": "primary action" },
    children: "Click me",
  });
}

async function captureNoAltImage(harness: BrowserFreeRenderCaptureHarness): Promise<RenderCaptureOutcome> {
  return harness.capture({
    orgId: ORG_ID,
    scenario: await firstButtonScenario(),
    componentSource: IMG_NO_ALT_SOURCE,
    componentExportName: "NoAltImage",
    designContractVersion: DESIGN_CONTRACT_VERSION,
  });
}

describe("deriveA11ySeverityBar (posture → axe impact bar)", () => {
  it("maps 'none' and empty to advisory (informational)", () => {
    expect(deriveA11ySeverityBar("none").kind).toBe("informational");
    expect(deriveA11ySeverityBar("").kind).toBe("informational");
  });
  it("maps WCAG conformance levels to the axe impacts that must be zero", () => {
    expect(deriveA11ySeverityBar("wcag-2.2-a")).toMatchObject({
      kind: "enforced",
      wcagLevel: "a",
      failingImpacts: ["critical"],
    });
    expect(deriveA11ySeverityBar("wcag-2.2-aa")).toMatchObject({
      kind: "enforced",
      wcagLevel: "aa",
      failingImpacts: ["serious", "critical"],
    });
    expect(deriveA11ySeverityBar("wcag2aaa")).toMatchObject({
      kind: "enforced",
      wcagLevel: "aaa",
      failingImpacts: ["minor", "moderate", "serious", "critical"],
    });
  });
  it("marks a declared-but-unrecognized standard unmappable (never advisory)", () => {
    expect(deriveA11ySeverityBar("apple-hig").kind).toBe("unmappable");
  });
});

describe("RenderA11yVerdictOracle", () => {
  it("REAL critical axe violation + a real WCAG posture → failed_visual with the rule id as evidence", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    // The harness really rendered the <img> (no fabricated axe result).
    const capture = await captureNoAltImage(harness);
    expect(capture.kind).toBe("captured");

    const oracle = new RenderA11yVerdictOracle(cas);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
    });

    expect(verdict.outcome).toBe("failed_visual");
    // The evidence is the REAL axe rule id — image-alt — at a real critical impact.
    const ruleIds = verdict.failingViolations.map((violation) => violation.id);
    expect(ruleIds).toContain("image-alt");
    const imageAlt = verdict.failingViolations.find((violation) => violation.id === "image-alt");
    expect(imageAlt?.impact).toBe("critical");
    // The verdict cites the exact a11y_audit bytes it judged.
    expect(verdict.a11yEvidenceDigest).not.toBeNull();
    expect(verdict.engine).toBe("axe-core");
  });

  it("clean component + a real WCAG posture → passed", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const capture = await captureButton(harness);
    expect(capture.kind).toBe("captured");

    const oracle = new RenderA11yVerdictOracle(cas);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
    });

    expect(verdict.outcome).toBe("passed");
    expect(verdict.failingViolations).toHaveLength(0);
    expect(verdict.a11yEvidenceDigest).not.toBeNull();
  });

  it("posture 'none' → passed even with a real critical violation (informational, not failing)", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const capture = await captureNoAltImage(harness);
    expect(capture.kind).toBe("captured");

    const oracle = new RenderA11yVerdictOracle(cas);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "none", notes: "" },
    });

    expect(verdict.outcome).toBe("passed");
    expect(verdict.failingViolations).toHaveLength(0);
    // The real violation is still recorded — as informational, not failing.
    expect(verdict.informationalViolations.map((violation) => violation.id)).toContain("image-alt");
  });

  it("FAIL-CLOSED: a render_failed capture → inconclusive, NEVER passed", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const broken = [
      'import { Nope } from "@tanren/definitely-not-real";',
      "export const Broken = () => Nope();",
      "",
    ].join("\n");
    const capture = await harness.capture({
      orgId: ORG_ID,
      scenario: await firstButtonScenario(),
      componentSource: broken,
      componentExportName: "Broken",
      designContractVersion: DESIGN_CONTRACT_VERSION,
    });
    expect(capture.kind).toBe("render_failed");

    const oracle = new RenderA11yVerdictOracle(cas);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
    });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("render failed");
  });

  it("FAIL-CLOSED: an absent/unreadable a11y_audit → inconclusive, NEVER passed", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const capture = await captureButton(harness);
    expect(capture.kind).toBe("captured");

    // Judge with an EMPTY store — the a11y bytes cannot be read back.
    const emptyStore = new InMemoryContentStore();
    const oracle = new RenderA11yVerdictOracle(emptyStore);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
    });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("unreadable");
  });

  it("FAIL-CLOSED: a declared-but-unmappable posture → inconclusive, NEVER passed", async () => {
    const cas = new InMemoryContentStore();
    const harness = new BrowserFreeRenderCaptureHarness(cas);
    const capture = await captureButton(harness);
    expect(capture.kind).toBe("captured");

    const oracle = new RenderA11yVerdictOracle(cas);
    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture,
      accessibilityPosture: { standard: "apple-hig", notes: "" },
    });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("cannot be mapped");
  });
});
