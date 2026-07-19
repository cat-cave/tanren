// ds-4 Slice B — the REAL end-to-end proof, gated on TANREN_DS4_PIXEL_E2E=1 (the
// RLS-suite pattern) because it needs podman + the render-worker image, not present in
// every CI lane. It builds the render-worker image, then drives the WHOLE real pipeline:
// a real React component → SSR → a REAL containerized Playwright chromium screenshot →
// stored in CAS → a REAL pixel diff. It asserts the anti-cosplay contract with LIVE
// pixels: an unchanged component vs its baseline → diffRatio ≈ 0 → passed; a
// deliberately-CHANGED variant → diffRatio > 0 → failed_visual.
//
// Run: TANREN_DS4_PIXEL_E2E=1 corepack pnpm exec vitest run \
//   services/orchestrator/tests/pixelRenderWorker.e2e.test.ts   (from the worktree root)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  contentDigestOf,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { DesignRenderScenario } from "../src/engine/design/system/designTargetAdapter.js";
import type { VisualComparisonRules } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import { PixelRenderCaptureHarness } from "../src/engine/design/render/pixelRenderCaptureHarness.js";
import {
  buildPodmanScreenshotRunner,
  DEFAULT_RENDER_WORKER_IMAGE,
} from "../src/engine/design/render/podmanScreenshotRunner.js";
import { PixelVisualDiffOracle } from "../src/engine/design/render/visualDiffOracle.js";

const execFileAsync = promisify(execFile);
const ENABLED = process.env["TANREN_DS4_PIXEL_E2E"] === "1";
const PODMAN = process.env["TANREN_PODMAN_BIN"] ?? "podman";
const ORG_ID = "org_ds4_pixel_e2e";
const DCV = "dcv_e2e";

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

function scenario(): DesignRenderScenario {
  return {
    scenarioKey: "swatch:light:desktop",
    component: "swatch",
    theme: "light",
    viewport: "desktop",
    locale: "en-US",
  };
}

/** A real React component whose background is parameterized so we can force a visual change. */
function swatchSource(background: string): string {
  return [
    'import * as React from "react";',
    "export const Swatch = () =>",
    `  React.createElement("div", { style: { width: 300, height: 200, background: "${background}" } }, "ds-4");`,
    "",
  ].join("\n");
}

const RULES: VisualComparisonRules = {
  imageDiffThreshold: 0.01,
  layoutTolerance: 0,
  tokenRules: [],
  contrastMinimum: 4.5,
  semanticRules: [],
};

describe.skipIf(!ENABLED)("ds-4 Slice B — real containerized screenshot + diff (podman)", () => {
  beforeAll(async () => {
    // Build the render-worker image (idempotent — layers cache). The build context is the
    // Dockerfile dir shipped in the repo.
    const context = join(import.meta.dirname, "..", "docker", "render-worker");
    await execFileAsync(PODMAN, ["build", "-t", DEFAULT_RENDER_WORKER_IMAGE, context], {
      maxBuffer: 64 * 1024 * 1024,
    });
  });

  it("captures a REAL screenshot of a real component and stores real PNG bytes in CAS", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, buildPodmanScreenshotRunner());

    const outcome = await harness.capture({
      orgId: ORG_ID,
      scenario: scenario(),
      componentSource: swatchSource("#4f46e5"),
      componentExportName: "Swatch",
      designContractVersion: DCV,
    });

    expect(outcome.kind).toBe("pixel_captured");
    if (outcome.kind !== "pixel_captured") return;
    const stored = await cas.get(ORG_ID, outcome.captureRef.casRef.digest);
    // A REAL, non-trivial PNG from a live chromium.
    expect(stored.bytes.byteLength).toBeGreaterThan(100);
    const decoded = PNG.sync.read(Buffer.from(stored.bytes));
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(800);
  });

  it("unchanged vs baseline → diffRatio ≈ 0 → passed; CHANGED variant → diffRatio > 0 → failed_visual", async () => {
    const cas = new InMemoryContentStore();
    const harness = new PixelRenderCaptureHarness(cas, buildPodmanScreenshotRunner());
    const oracle = new PixelVisualDiffOracle(cas);

    // Baseline: a live screenshot of the indigo swatch.
    const baseline = await harness.capture({
      orgId: ORG_ID,
      scenario: scenario(),
      componentSource: swatchSource("#4f46e5"),
      componentExportName: "Swatch",
      designContractVersion: DCV,
    });
    expect(baseline.kind).toBe("pixel_captured");
    if (baseline.kind !== "pixel_captured") return;
    const baselineRef = baseline.captureRef.casRef;

    // Unchanged: re-screenshot the SAME component → identical pixels → passed.
    const same = await harness.capture({
      orgId: ORG_ID,
      scenario: scenario(),
      componentSource: swatchSource("#4f46e5"),
      componentExportName: "Swatch",
      designContractVersion: DCV,
    });
    const samePass = await oracle.judge({ orgId: ORG_ID, capture: same, baseline: baselineRef, rules: RULES });
    expect(samePass.outcome).toBe("passed");
    expect(samePass.diffRatio).toBe(0);

    // CHANGED: the swatch is now red → a real, large pixel diff → failed_visual.
    const changed = await harness.capture({
      orgId: ORG_ID,
      scenario: scenario(),
      componentSource: swatchSource("#dc2626"),
      componentExportName: "Swatch",
      designContractVersion: DCV,
    });
    const changedFail = await oracle.judge({ orgId: ORG_ID, capture: changed, baseline: baselineRef, rules: RULES });
    expect(changedFail.outcome).toBe("failed_visual");
    expect(changedFail.diffRatio ?? 0).toBeGreaterThan(RULES.imageDiffThreshold);
  });
});
