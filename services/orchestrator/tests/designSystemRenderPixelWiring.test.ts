// ds-4 Slice B — proves the pixel path is WIRED INTO PRODUCTION (not a dead library):
// it drives the REAL `verifyComposedDesignSystemRender` producer with injected pixel
// wiring (a fake runner returning REAL PNGs + an injected baseline — the runner is the
// container seam, injecting it is the documented test pattern) and shows:
//   · knob OFF (pixel undefined)         → a11y-only, ZERO ::pixel checkpoints (no-op).
//   · infra absent (available()=false)   → every pixel scenario inconclusive → BLOCKED,
//                                           runner NEVER invoked (no silent skip).
//   · changed screenshot vs baseline     → failed_visual → the design_render gate section
//                                           is `failed` (land BLOCKED).
//   · unchanged vs baseline              → passed.
//   · absent baseline                    → inconclusive → BLOCKED (never a first-time pass).

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  contentDigestOf,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { VisualComparisonRules } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import { verifyComposedDesignSystemRender } from "../src/engine/design/render/designSystemRenderVerification.js";
import { designRenderGateSection } from "../src/engine/design/render/designRenderGateProof.js";
import type { DesignRenderVerification } from "../src/engine/design/render/designRenderVerdict.js";
import type { DesignRenderVerdictRow } from "../src/engine/design/render/designRenderVerdictStore.js";
import type {
  PixelBaselineResolver,
  PixelVerificationWiring,
} from "../src/engine/design/render/pixelRenderScenarioPass.js";
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

const ORG_ID = "org_ds4_wiring";
const DCV = "3";

function solidPng(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

/** A runner that returns a fixed REAL PNG and records how many times it was invoked. */
class FixtureRunner implements PixelRenderRunner {
  public calls = 0;
  public constructor(private readonly png: Uint8Array) {}
  async screenshot(input: {
    documentHtml: string;
    viewport: { width: number; height: number };
  }): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
    this.calls += 1;
    return { ok: true, png: this.png, viewport: input.viewport };
  }
}

class NeverRunner implements PixelRenderRunner {
  public calls = 0;
  async screenshot(): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
    this.calls += 1;
    return { ok: false, reason: "should never be called" };
  }
}

const RULES: VisualComparisonRules = {
  imageDiffThreshold: 0.01,
  layoutTolerance: 0,
  tokenRules: [],
  contrastMinimum: 0,
  semanticRules: [],
};

// A minimal REAL SSR-able component (a styled div) — one scenario, deterministic.
const SWATCH_SOURCE = [
  'import * as React from "react";',
  'export const Swatch = () => React.createElement("div", { style: { width: 40, height: 40 } }, "ds4");',
  "",
].join("\n");

function build() {
  return {
    catalog: { components: [{ key: "swatch", sourcePath: "components/ui/swatch.tsx" }] },
    files: [{ path: "components/ui/swatch.tsx", bytes: new TextEncoder().encode(SWATCH_SOURCE) }],
  };
}

const SCENARIOS = [
  {
    scenarioKey: "swatch:light:desktop:en-US",
    component: "swatch",
    theme: "light",
    viewport: "desktop",
    locale: "en-US",
  },
];

function resolverFor(ref: CasArtifactRef | null): PixelBaselineResolver {
  return { resolve: async () => ref };
}

function wiring(over: Partial<PixelVerificationWiring> & { runner: PixelRenderRunner }): PixelVerificationWiring {
  return {
    runner: over.runner,
    baselineResolver: over.baselineResolver ?? resolverFor(null),
    rules: over.rules ?? RULES,
    available: over.available ?? (async () => true),
  };
}

/** Build a verdict row from a verification (the shape the land gate reads). */
function rowFrom(v: DesignRenderVerification): DesignRenderVerdictRow {
  return {
    outcome: v.outcome,
    accessibilityStandard: v.accessibilityStandard,
    designContractVersion: DCV,
    releaseId: "release_1",
    contractDigest: `sha256:${"a".repeat(64)}`,
    failingScenarioKey: v.failingScenarioKey,
    failingRuleIds: v.failingRuleIds,
    checkpointCount: v.checkpoints.length,
    checkpoints: v.checkpoints,
  };
}

describe("ds-4 Slice B — pixel path wired into verifyComposedDesignSystemRender", () => {
  it("knob OFF (pixel undefined) → a11y-only, NO ::pixel checkpoints (genuine no-op)", async () => {
    const cas = new InMemoryContentStore();
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_pixel_wiring",
      eventStore: { append: async () => {} },
      cas,
      build: build(),
      scenarios: SCENARIOS,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
      designContractVersion: DCV,
      // pixel: undefined
    });
    // The a11y pass judged the swatch (passed); no pixel checkpoint exists.
    expect(verification.checkpoints.some((c) => c.checkpointId.endsWith("::pixel"))).toBe(false);
    expect(verification.checkpoints.every((c) => c.diffRatio === undefined)).toBe(true);
    expect(verification.outcome).toBe("passed");
  });

  it("infra ABSENT (available=false) → pixel scenarios inconclusive → BLOCKED, runner never invoked", async () => {
    const cas = new InMemoryContentStore();
    const runner = new NeverRunner();
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_pixel_wiring",
      eventStore: { append: async () => {} },
      cas,
      build: build(),
      scenarios: SCENARIOS,
      // a11y advisory ("none") → the pixel pass is the only evidence for this run.
      accessibilityPosture: { standard: "none", notes: "" },
      designContractVersion: DCV,
      pixel: wiring({ runner, available: async () => false }),
    });
    expect(runner.calls).toBe(0);
    // A pixel checkpoint exists but is unknown → the run cannot pass.
    const pixel = verification.checkpoints.find((c) => c.checkpointId.endsWith("::pixel"));
    expect(pixel?.verdict).toBe("unknown");
    expect(verification.outcome).toBe("inconclusive_infrastructure");
    expect(designRenderGateSection(rowFrom(verification), true).verdict).toBe("unknown");
  });

  it("CHANGED screenshot vs baseline → failed_visual → design_render gate section BLOCKED", async () => {
    const cas = new InMemoryContentStore();
    // The accepted baseline is an indigo swatch stored in CAS.
    const baseline = await cas.put({
      orgId: ORG_ID,
      bytes: solidPng(48, 48, [79, 70, 229, 255]),
      mediaType: "image/png",
    });
    // The runner returns a RED swatch — a real visual change.
    const runner = new FixtureRunner(solidPng(48, 48, [220, 38, 38, 255]));

    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      cas,
      build: build(),
      scenarios: SCENARIOS,
      accessibilityPosture: { standard: "none", notes: "" },
      designContractVersion: DCV,
      pixel: wiring({ runner, baselineResolver: resolverFor(baseline) }),
    });

    expect(runner.calls).toBe(1);
    const pixel = verification.checkpoints.find((c) => c.checkpointId.endsWith("::pixel"));
    expect(pixel?.verdict).toBe("failed");
    expect(pixel?.diffRatio ?? 0).toBeGreaterThan(RULES.imageDiffThreshold);
    expect(pixel?.screenshotDigest).toBeDefined();
    expect(verification.outcome).toBe("failed_visual");
    // The land gate section is BLOCKED (failed).
    expect(designRenderGateSection(rowFrom(verification), true).verdict).toBe("failed");
  });

  it("UNCHANGED screenshot vs baseline → passed", async () => {
    const cas = new InMemoryContentStore();
    const png = solidPng(48, 48, [79, 70, 229, 255]);
    const baseline = await cas.put({ orgId: ORG_ID, bytes: png, mediaType: "image/png" });
    const runner = new FixtureRunner(png);

    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      cas,
      build: build(),
      scenarios: SCENARIOS,
      accessibilityPosture: { standard: "none", notes: "" },
      designContractVersion: DCV,
      pixel: wiring({ runner, baselineResolver: resolverFor(baseline) }),
    });

    const pixel = verification.checkpoints.find((c) => c.checkpointId.endsWith("::pixel"));
    expect(pixel?.verdict).toBe("passed");
    expect(pixel?.diffRatio).toBe(0);
    expect(verification.outcome).toBe("passed");
  });

  it("ABSENT baseline (first compose) → inconclusive → BLOCKED (never a first-time pass)", async () => {
    const cas = new InMemoryContentStore();
    const runner = new FixtureRunner(solidPng(48, 48, [79, 70, 229, 255]));

    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      cas,
      build: build(),
      scenarios: SCENARIOS,
      accessibilityPosture: { standard: "none", notes: "" },
      designContractVersion: DCV,
      pixel: wiring({ runner, baselineResolver: resolverFor(null) }),
    });

    const pixel = verification.checkpoints.find((c) => c.checkpointId.endsWith("::pixel"));
    expect(pixel?.verdict).toBe("unknown");
    expect(verification.outcome).toBe("inconclusive_infrastructure");
    expect(designRenderGateSection(rowFrom(verification), true).verdict).toBe("unknown");
  });

  it("enforced a11y + pixel BOTH run → a11y-passing swatch + failing pixel → failed_visual (merged gate)", async () => {
    const cas = new InMemoryContentStore();
    const baseline = await cas.put({ orgId: ORG_ID, bytes: solidPng(48, 48, [0, 0, 0, 255]), mediaType: "image/png" });
    const runner = new FixtureRunner(solidPng(48, 48, [255, 255, 255, 255]));

    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_pixel_wiring",
      eventStore: { append: async () => {} },
      cas,
      build: build(),
      scenarios: SCENARIOS,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
      designContractVersion: DCV,
      pixel: wiring({ runner, baselineResolver: resolverFor(baseline) }),
    });

    // Both an a11y checkpoint (plain key) and a pixel checkpoint (::pixel) exist.
    expect(verification.checkpoints.some((c) => !c.checkpointId.endsWith("::pixel"))).toBe(true);
    expect(verification.checkpoints.some((c) => c.checkpointId.endsWith("::pixel"))).toBe(true);
    // The failing pixel checkpoint dominates the merged aggregate → blocked.
    expect(verification.outcome).toBe("failed_visual");
  });
});
