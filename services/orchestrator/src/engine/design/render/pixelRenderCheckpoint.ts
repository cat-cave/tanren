// ds-4 Slice B sub-node #3 — map a pixel visual-diff verdict onto the SHARED
// design-render checkpoint model, so the real `diffRatio` flows through the SAME
// aggregation (`aggregateDesignRenderOutcome`), persistence
// (`designRenderVerdictStore`), and native gate (`designRenderProofBody`) as the
// Slice-A a11y verdicts — one design_render gate, two evidence kinds.
//
// The checkpoint verdict reuses the fail-closed oracle mapping (`inconclusive` →
// `unknown`, which BLOCKS a required section). The real diffRatio rides along on the
// checkpoint and is surfaced in the gate body; it is NEVER synthesized.

import { checkpointVerdictFromOracle, type DesignRenderCheckpoint } from "./designRenderVerdict.js";
import type { PixelRenderVerdict } from "./visualDiffOracle.js";

/** The suffix that distinguishes a pixel checkpoint from the a11y checkpoint of the SAME scenario. */
export const PIXEL_CHECKPOINT_SUFFIX = "::pixel";

/** The pixel checkpoint id for a scenario (a11y + pixel checkpoints coexist under one gate). */
export function pixelCheckpointId(scenarioKey: string): string {
  return `${scenarioKey}${PIXEL_CHECKPOINT_SUFFIX}`;
}

/** Recover the scenario key from a pixel checkpoint id (used to key the baseline lookup). */
export function scenarioKeyFromPixelCheckpointId(checkpointId: string): string | null {
  return checkpointId.endsWith(PIXEL_CHECKPOINT_SUFFIX) ? checkpointId.slice(0, -PIXEL_CHECKPOINT_SUFFIX.length) : null;
}

/**
 * Build a {@link DesignRenderCheckpoint} from a pixel visual-diff verdict. The
 * checkpoint carries the real `diffRatio` (only when the oracle actually computed
 * one — a nonnegative number) + the captured screenshot digest (the next release's
 * baseline anchor); an inconclusive verdict maps to `unknown` and omits the ratio, so
 * the gate blocks rather than passing on a diff it never computed. The checkpoint id is
 * suffixed so it never collides with the same scenario's a11y checkpoint.
 */
export function checkpointFromPixelVerdict(verdict: PixelRenderVerdict): DesignRenderCheckpoint {
  const gateVerdict = checkpointVerdictFromOracle(verdict.outcome);
  const hasRealRatio =
    typeof verdict.diffRatio === "number" && Number.isFinite(verdict.diffRatio) && verdict.diffRatio >= 0;
  return {
    checkpointId: pixelCheckpointId(verdict.scenarioKey),
    verdict: gateVerdict,
    // Visual diffs carry no axe rule ids; the diffRatio IS the evidence.
    failingRuleIds: [],
    ...(hasRealRatio ? { diffRatio: verdict.diffRatio } : {}),
    ...(verdict.screenshotDigest === null ? {} : { screenshotDigest: verdict.screenshotDigest }),
  };
}
