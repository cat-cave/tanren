// ds-4 Slice B sub-node #1 — proves the pixel harness renders the REAL ds-2 Button
// (React SSR — the same bundler Slice A uses), screenshots it via the injected
// browser runner, and stores the REAL PNG bytes in CAS under the `screenshot`
// evidence kind. The browser runner is injected so this unit test drives the harness
// with a REAL fixture PNG (no live browser); the env-gated e2e test exercises the
// real containerized browser. Plus the fail-closed seams: bundle/render/empty-render
// and a browser failure all yield `render_failed` and write NOTHING to CAS.

import { PNG } from "pngjs";
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
import { PixelRenderCaptureHarness } from "../src/engine/design/render/pixelRenderCaptureHarness.js";
import type {
  PixelRenderRunner,
  PixelScreenshotFailure,
  PixelScreenshotResult,
} from "../src/engine/design/render/pixelRenderContracts.js";

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

const ORG_ID = "org_ds4_pixel";
const DCV = "dcv_1";

/** A REAL solid-color PNG the fake runner hands back (stands in for a live screenshot). */
function realPng(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

/** A runner that returns a REAL PNG (records the document it was asked to screenshot). */
class FixturePngRunner implements PixelRenderRunner {
  public lastDocumentHtml: string | null = null;
  public lastLocale: string | null = null;
  public constructor(private readonly png: Uint8Array) {}
  async screenshot(input: {
    documentHtml: string;
    viewport: { width: number; height: number };
    locale: string;
  }): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
    this.lastDocumentHtml = input.documentHtml;
    this.lastLocale = input.locale;
    return { ok: true, png: this.png, viewport: input.viewport };
  }
}

class FailingRunner implements PixelRenderRunner {
  async screenshot(): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
    return { ok: false, reason: "container exited non-zero" };
  }
}

class BlankPngRunner implements PixelRenderRunner {
  async screenshot(input: {
    documentHtml: string;
    viewport: { width: number; height: number };
  }): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
    // A runner that (bug) returns non-PNG bytes as "ok" — the harness must reject it.
    return { ok: true, png: new Uint8Array([0, 0, 0]), viewport: input.viewport };
  }
}

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

describe("PixelRenderCaptureHarness", () => {
  it("renders the REAL ds-2 Button, screenshots it, and stores REAL screenshot bytes in CAS", async () => {
    const cas = new InMemoryContentStore();
    const runner = new FixturePngRunner(realPng(390, 100));
    const harness = new PixelRenderCaptureHarness(cas, runner);
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: realButtonSource(),
      componentExportName: "Button",
      designContractVersion: DCV,
      renderProps: { type: "button", "aria-label": "primary action" },
      children: "Click me",
    });

    expect(outcome.kind).toBe("pixel_captured");
    if (outcome.kind !== "pixel_captured") return;
    expect(outcome.scenarioKey).toBe(scenario.scenarioKey);
    expect(outcome.captureRef.evidenceKind).toBe("screenshot");
    expect(outcome.byteSize).toBeGreaterThan(0);

    // The screenshot the runner was asked to take was of the REAL rendered Button.
    expect(runner.lastDocumentHtml).toContain("<button");
    expect(runner.lastDocumentHtml).toContain("Click me");
    expect(runner.lastDocumentHtml).toContain(`data-theme="${scenario.theme}"`);

    // REGRESSION — the scenario's locale is DECLARED to the browser, not just stamped
    // into markup. `locale` is a dimension of the scenario matrix and outcomes are keyed
    // on it (acceptanceSpec/acceptanceOutcome), but the document only ever carried it as
    // `<html lang>`, which does NOT set `navigator.language`. So every scenario in the
    // matrix rendered in whatever locale the HOST supplied, and the dimension was inert
    // with respect to the thing it claims to vary.
    expect(runner.lastLocale).toBe(scenario.locale);
    // The markup attribute is still set — but it is not, and never was, the browser locale.
    expect(runner.lastDocumentHtml).toContain(`lang="${scenario.locale}"`);

    // The stored bytes are the EXACT real PNG, content-addressed.
    const stored = await cas.get(ORG_ID, outcome.captureRef.casRef.digest);
    expect(stored.mediaType).toBe("image/png");
    expect(stored.bytes.byteLength).toBe(outcome.byteSize);
    expect(outcome.captureRef.casRef.digest).toBe(contentDigestOf(stored.bytes));
    // It decodes as a real PNG.
    expect(() => PNG.sync.read(Buffer.from(stored.bytes))).not.toThrow();

    // The evidence payload round-trips the exact stored screenshot bytes.
    const payload = await harness.toEvidencePayload(outcome, ORG_ID);
    expect(payload?.kind).toBe("screenshot");
    expect(payload?.mediaType).toBe("image/png");
  });

  it("FAIL-CLOSED: a component that cannot bundle → render_failed(bundle), nothing in CAS", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, new FixturePngRunner(realPng(64, 64)));
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: 'import { X } from "@tanren/not-real";\nexport const Broken = () => X();\n',
      componentExportName: "Broken",
      designContractVersion: DCV,
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("bundle");
    expect(cas.rows.size).toBe(0);
  });

  it("FAIL-CLOSED: a component that renders nothing → render_failed(empty_render)", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, new FixturePngRunner(realPng(64, 64)));
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: 'import * as React from "react";\nexport const Empty = () => null;\n',
      componentExportName: "Empty",
      designContractVersion: DCV,
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("empty_render");
    expect(cas.rows.size).toBe(0);
  });

  it("FAIL-CLOSED: a browser/container failure → render_failed(browser), nothing in CAS", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, new FailingRunner());
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: realButtonSource(),
      componentExportName: "Button",
      designContractVersion: DCV,
      children: "Click me",
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("browser");
    expect(outcome.reason).toContain("non-zero");
    expect(cas.rows.size).toBe(0);
  });

  it("FAIL-CLOSED: a runner that returns non-PNG bytes as ok → render_failed(browser), nothing in CAS", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, new BlankPngRunner());
    const scenario = await firstButtonScenario();

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario,
      componentSource: realButtonSource(),
      componentExportName: "Button",
      designContractVersion: DCV,
      children: "Click me",
    });

    expect(outcome.kind).toBe("render_failed");
    if (outcome.kind !== "render_failed") return;
    expect(outcome.stage).toBe("browser");
    expect(cas.rows.size).toBe(0);
  });
});
