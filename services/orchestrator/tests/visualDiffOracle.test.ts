// ds-4 Slice B sub-node #2 — proves the visual-diff oracle computes a REAL per-pixel
// diffRatio over REAL fixture PNGs (pngjs-encoded, pixelmatch-diffed): an unchanged
// screenshot vs its baseline → diffRatio ≈ 0 → passed; a deliberately-CHANGED variant
// → diffRatio > 0 → failed_visual. Plus the fail-closed seams: an absent baseline, an
// undecodable screenshot, and a dimension mismatch are inconclusive, NEVER a pass. No
// stub diff — every ratio comes from actual pixel comparison.

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
import { PixelVisualDiffOracle } from "../src/engine/design/render/visualDiffOracle.js";
import type { PixelCaptureOutcome } from "../src/engine/design/render/pixelRenderContracts.js";

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

/** Build a REAL solid-color PNG (encoded by pngjs) of the given size. */
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

/** A REAL PNG identical to `solidPng` but with a filled rectangle painted over it. */
function pngWithRect(
  width: number,
  height: number,
  base: readonly [number, number, number, number],
  rect: { x: number; y: number; w: number; h: number; rgba: readonly [number, number, number, number] },
): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inRect = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const rgba = inRect ? rect.rgba : base;
      const idx = (y * width + x) * 4;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

const RULES: VisualComparisonRules = {
  imageDiffThreshold: 0.01,
  layoutTolerance: 0,
  tokenRules: [],
  contrastMinimum: 4.5,
  semanticRules: [],
};

async function captured(cas: InMemoryContentStore, bytes: Uint8Array): Promise<PixelCaptureOutcome> {
  const ref = await cas.put({ orgId: ORG_ID, bytes, mediaType: "image/png" });
  return {
    kind: "pixel_captured",
    scenarioKey: "button:light:desktop",
    designContractVersion: DCV,
    captureRef: { kind: "screenshot", evidenceKind: "screenshot", casRef: ref, viewport: { width: 64, height: 64 } },
    byteSize: ref.byteSize,
  };
}

describe("PixelVisualDiffOracle", () => {
  it("unchanged screenshot vs baseline → REAL diffRatio ≈ 0 → passed", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const bytes = solidPng(64, 64, [79, 70, 229, 255]);
    // Baseline + actual are byte-identical real screenshots.
    const baseline = await cas.put({ orgId: ORG_ID, bytes, mediaType: "image/png" });
    const capture = await captured(cas, bytes);

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline, rules: RULES });

    expect(verdict.outcome).toBe("passed");
    expect(verdict.diffRatio).toBe(0);
    expect(verdict.mismatchedPixels).toBe(0);
    expect(verdict.totalPixels).toBe(64 * 64);
    expect(verdict.diffArtifactDigest).not.toBeNull();
    expect(verdict.reason).toBeNull();
  });

  it("deliberately-CHANGED variant vs baseline → REAL diffRatio > 0 → failed_visual", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const baselineBytes = solidPng(64, 64, [79, 70, 229, 255]);
    // The actual paints a bright rectangle over ~1/4 of the frame — a real visual change.
    const changedBytes = pngWithRect(64, 64, [79, 70, 229, 255], {
      x: 0,
      y: 0,
      w: 32,
      h: 32,
      rgba: [255, 0, 0, 255],
    });
    const baseline = await cas.put({ orgId: ORG_ID, bytes: baselineBytes, mediaType: "image/png" });
    const capture = await captured(cas, changedBytes);

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline, rules: RULES });

    expect(verdict.outcome).toBe("failed_visual");
    expect(verdict.diffRatio).not.toBeNull();
    expect(verdict.diffRatio ?? 0).toBeGreaterThan(RULES.imageDiffThreshold);
    // ~1/4 of the pixels changed.
    expect(verdict.diffRatio ?? 0).toBeCloseTo(0.25, 2);
    expect(verdict.mismatchedPixels).toBe(32 * 32);
    // The diff image is a REAL stored artifact.
    expect(verdict.diffArtifactDigest).not.toBeNull();
    expect(cas.rows.has(verdict.diffArtifactDigest as Digest)).toBe(true);
  });

  it("a change UNDER the threshold → passed (the threshold is honored, not ignored)", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const baselineBytes = solidPng(64, 64, [79, 70, 229, 255]);
    // A single changed pixel: 1/4096 ≈ 0.00024, under the 0.01 threshold.
    const changedBytes = pngWithRect(64, 64, [79, 70, 229, 255], { x: 0, y: 0, w: 1, h: 1, rgba: [255, 0, 0, 255] });
    const baseline = await cas.put({ orgId: ORG_ID, bytes: baselineBytes, mediaType: "image/png" });
    const capture = await captured(cas, changedBytes);

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline, rules: RULES });

    expect(verdict.mismatchedPixels).toBe(1);
    expect(verdict.outcome).toBe("passed");
  });

  it("FAIL-CLOSED: an ABSENT baseline → inconclusive_infrastructure, never a pass", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const capture = await captured(cas, solidPng(64, 64, [79, 70, 229, 255]));

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline: null, rules: RULES });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.diffRatio).toBeNull();
    expect(verdict.reason).toContain("no accepted baseline");
  });

  it("FAIL-CLOSED: a failed pixel capture → inconclusive_infrastructure", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const baseline = await cas.put({ orgId: ORG_ID, bytes: solidPng(64, 64, [0, 0, 0, 255]), mediaType: "image/png" });

    const verdict = await oracle.judge({
      orgId: ORG_ID,
      capture: {
        kind: "render_failed",
        scenarioKey: "button:light:desktop",
        designContractVersion: DCV,
        stage: "browser",
        reason: "container crashed",
      },
      baseline,
      rules: RULES,
    });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("container crashed");
  });

  it("FAIL-CLOSED: a dimension mismatch → inconclusive_infrastructure (no honest per-pixel ratio)", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const baseline = await cas.put({ orgId: ORG_ID, bytes: solidPng(32, 32, [0, 0, 0, 255]), mediaType: "image/png" });
    const capture = await captured(cas, solidPng(64, 64, [0, 0, 0, 255]));

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline, rules: RULES });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("dimensions");
  });

  it("FAIL-CLOSED: an undecodable screenshot → inconclusive_infrastructure", async () => {
    const cas = new InMemoryContentStore();
    const oracle = new PixelVisualDiffOracle(cas);
    const baseline = await cas.put({ orgId: ORG_ID, bytes: solidPng(64, 64, [0, 0, 0, 255]), mediaType: "image/png" });
    // Store bytes that are NOT a valid PNG under a real content digest.
    const garbageRef = await cas.put({ orgId: ORG_ID, bytes: new Uint8Array([1, 2, 3, 4, 5]), mediaType: "image/png" });
    const capture: PixelCaptureOutcome = {
      kind: "pixel_captured",
      scenarioKey: "button:light:desktop",
      designContractVersion: DCV,
      captureRef: {
        kind: "screenshot",
        evidenceKind: "screenshot",
        casRef: garbageRef,
        viewport: { width: 64, height: 64 },
      },
      byteSize: garbageRef.byteSize,
    };

    const verdict = await oracle.judge({ orgId: ORG_ID, capture, baseline, rules: RULES });

    expect(verdict.outcome).toBe("inconclusive_infrastructure");
    expect(verdict.reason).toContain("undecodable");
  });
});
