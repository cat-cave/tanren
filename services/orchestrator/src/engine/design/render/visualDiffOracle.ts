// ds-4 Slice B sub-node #2 — the REAL visual-diff verdict oracle.
//
// The pixel counterpart of `renderVerdictOracle.ts` (which judges the a11y audit):
// this oracle reads the EXACT screenshot bytes the pixel harness stored in CAS,
// decodes them + a baseline screenshot, and runs a REAL per-pixel diff
// (pixelmatch over pngjs-decoded RGBA) to produce a `diffRatio` in [0, 1]. It NEVER
// fabricates a diff — the ratio is `mismatchedPixels / totalPixels` from actual
// pixel comparison, and the diff image is itself stored content-addressed.
//
// Fail-closed verdict vocabulary (shared with Slice A):
//   · passed                      — diffRatio ≤ the contract's image-diff threshold.
//   · failed_visual               — diffRatio > the threshold (a real visual regression).
//   · inconclusive_infrastructure — the capture failed, the baseline is ABSENT, either
//                                   screenshot is unreadable/undecodable, or the two
//                                   differ in dimensions (no honest per-pixel diff).
// Absence, an unreadable screenshot, and an un-diffable pair are NEVER a pass.

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CasArtifactRef, CasByteStore, Digest } from "../../contracts/cas.js";
import type { RenderVerdictOutcome, VisualComparisonRules } from "../../contracts/runtimeVerificationAdapters.js";
import type { PixelCaptureOutcome } from "./pixelRenderContracts.js";

const DIFF_MEDIA_TYPE = "image/png";
/** The per-pixel color-distance sensitivity handed to pixelmatch (0 strict … 1 lax). */
const DEFAULT_PIXEL_THRESHOLD = 0.1;

/**
 * The pixel-diff verdict. Deliberately distinct from the a11y `RenderA11yVerdict`:
 * it carries the REAL `diffRatio` + the CAS digests of the exact screenshots judged
 * and the stored diff image. Sub-node #3 maps `outcome` + `diffRatio` onto the gate.
 */
export interface PixelRenderVerdict {
  readonly outcome: RenderVerdictOutcome;
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  /** The real per-pixel diff ratio in [0, 1] (null only when it could not be computed). */
  readonly diffRatio: number | null;
  /** The threshold the ratio was judged against (from the contract's visual rules). */
  readonly threshold: number;
  /** The CAS digest of the actual screenshot judged (null when the capture failed). */
  readonly screenshotDigest: Digest | null;
  /** The CAS digest of the baseline judged against (null when absent). */
  readonly baselineDigest: Digest | null;
  /** The CAS digest of the stored diff image (null unless a diff was actually computed). */
  readonly diffArtifactDigest: Digest | null;
  readonly mismatchedPixels: number | null;
  readonly totalPixels: number | null;
  /** A human reason, populated for `inconclusive_infrastructure`. */
  readonly reason: string | null;
}

export interface VisualDiffInput {
  readonly orgId: string;
  /** The pixel harness capture outcome (`pixel_captured` or `render_failed`) to judge. */
  readonly capture: PixelCaptureOutcome;
  /** The accepted baseline screenshot for this scenario, or `null` when none exists yet. */
  readonly baseline: CasArtifactRef | null;
  /** The project's visual comparison rules, from the design contract. */
  readonly rules: VisualComparisonRules;
}

/**
 * The visual-diff oracle. Constructed with the org-scoped `CasByteStore` so it reads
 * the EXACT screenshot bytes the harness stored (never a re-render), computes a real
 * pixel diff, and stores the real diff image back content-addressed.
 */
export class PixelVisualDiffOracle {
  public constructor(private readonly cas: CasByteStore) {}

  public async judge(input: VisualDiffInput): Promise<PixelRenderVerdict> {
    const { capture, rules } = input;
    const threshold = normalizeThreshold(rules.imageDiffThreshold);

    if (capture.kind === "render_failed") {
      return inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        threshold,
        null,
        null,
        `pixel capture failed at stage '${capture.stage}': ${capture.reason}`,
      );
    }
    const screenshotDigest = capture.captureRef.casRef.digest;

    // Fail-closed: an ABSENT baseline is inconclusive, never a silent pass. The first
    // screenshot for a scenario has nothing to diff against — it cannot be green.
    if (input.baseline === null) {
      return inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        threshold,
        screenshotDigest,
        null,
        "no accepted baseline screenshot exists for this scenario (first capture is inconclusive, not a pass)",
      );
    }
    const baselineDigest = input.baseline.digest;

    let actualPng: PNG;
    let baselinePng: PNG;
    try {
      actualPng = PNG.sync.read(Buffer.from((await this.cas.get(input.orgId, screenshotDigest)).bytes));
    } catch (error) {
      return inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        threshold,
        screenshotDigest,
        baselineDigest,
        `actual screenshot is unreadable/undecodable from CAS: ${describe(error)}`,
      );
    }
    try {
      baselinePng = PNG.sync.read(Buffer.from((await this.cas.get(input.orgId, baselineDigest)).bytes));
    } catch (error) {
      return inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        threshold,
        screenshotDigest,
        baselineDigest,
        `baseline screenshot is unreadable/undecodable from CAS: ${describe(error)}`,
      );
    }

    // A per-pixel diff is only meaningful at matched dimensions; a size mismatch is
    // inconclusive (a layout change we cannot honestly express as a pixel ratio).
    if (actualPng.width !== baselinePng.width || actualPng.height !== baselinePng.height) {
      return inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        threshold,
        screenshotDigest,
        baselineDigest,
        `screenshot dimensions ${actualPng.width}x${actualPng.height} differ from baseline ${baselinePng.width}x${baselinePng.height}`,
      );
    }

    const { width, height } = actualPng;
    const totalPixels = width * height;
    const diff = new PNG({ width, height });
    // REAL per-pixel comparison: pixelmatch returns the count of mismatched pixels.
    const mismatchedPixels = pixelmatch(baselinePng.data, actualPng.data, diff.data, width, height, {
      threshold: DEFAULT_PIXEL_THRESHOLD,
    });
    const diffRatio = totalPixels === 0 ? 0 : mismatchedPixels / totalPixels;
    const diffRef = await this.cas.put({ orgId: input.orgId, bytes: PNG.sync.write(diff), mediaType: DIFF_MEDIA_TYPE });

    const outcome: RenderVerdictOutcome = diffRatio > threshold ? "failed_visual" : "passed";
    return {
      outcome,
      scenarioKey: capture.scenarioKey,
      designContractVersion: capture.designContractVersion,
      diffRatio,
      threshold,
      screenshotDigest,
      baselineDigest,
      diffArtifactDigest: diffRef.digest,
      mismatchedPixels,
      totalPixels,
      reason: null,
    };
  }
}

/** A threshold is a ratio in [0, 1]; a non-finite/out-of-range value clamps to 0 (strictest). */
function normalizeThreshold(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(1, raw);
}

function inconclusive(
  scenarioKey: string,
  designContractVersion: string,
  threshold: number,
  screenshotDigest: Digest | null,
  baselineDigest: Digest | null,
  reason: string,
): PixelRenderVerdict {
  return {
    outcome: "inconclusive_infrastructure",
    scenarioKey,
    designContractVersion,
    diffRatio: null,
    threshold,
    screenshotDigest,
    baselineDigest,
    diffArtifactDigest: null,
    mismatchedPixels: null,
    totalPixels: null,
    reason,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
