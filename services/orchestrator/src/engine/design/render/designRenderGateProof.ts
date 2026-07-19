// ds-4 sub-node #3 — map the persisted design-render verdict onto the native gate's
// `design_render` proof section (GateProofBundleV2). The a11y/DOM path carries NO pixel
// diff, so `diffRatio` is OMITTED (never faked); the Slice-B render-worker (browser) path
// carries the REAL per-pixel `diffRatio` on its checkpoints and it is surfaced here. The
// section VERDICT mirrors the fail-closed land gate: `passed` → passed, `failed_visual` →
// failed, everything else → unknown (blocks a required section via `aggregateGateVerdict`).

import type { DesignRenderBody, GateSectionVerdict } from "../../contracts/gateProof.js";
import { DesignRenderBodySchema } from "../../contracts/gateProof.js";
import type { GateVerdict } from "../../contracts/mergeAuthority.js";
import type { DesignRenderVerdictRow } from "./designRenderVerdictStore.js";

/** The typed `design_render` proof body built from a persisted verdict (validated fail-closed). */
export function designRenderProofBody(verdict: DesignRenderVerdictRow): DesignRenderBody {
  return DesignRenderBodySchema.parse({
    designContractVersions: [verdict.designContractVersion],
    checkpointCount: verdict.checkpoints.length,
    // `diffRatio` rides along ONLY for Slice-B pixel checkpoints that carry a real
    // computed ratio; the browser-free a11y path omits it (never fabricates a pixel diff).
    renderVerdicts: verdict.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      verdict: checkpoint.verdict,
      ...(checkpoint.diffRatio === undefined ? {} : { diffRatio: checkpoint.diffRatio }),
    })),
  });
}

/** Map a run-level design-render outcome onto the fail-closed gate section verdict. */
export function designRenderSectionVerdict(outcome: DesignRenderVerdictRow["outcome"]): GateVerdict {
  if (outcome === "passed") return "passed";
  if (outcome === "failed_visual") return "failed";
  // not_applicable / inconclusive_infrastructure → unknown: a required section left unknown
  // blocks (aggregateGateVerdict), never a silent pass.
  return "unknown";
}

/**
 * Build the `design_render` {@link GateSectionVerdict} from a persisted verdict + whether the
 * section is required for the run (a real, non-"none" posture). `required: false` (or a
 * `not_applicable` verdict) never blocks the aggregate.
 */
export function designRenderGateSection(verdict: DesignRenderVerdictRow, required: boolean): GateSectionVerdict {
  return {
    kind: "design_render",
    required,
    verdict: designRenderSectionVerdict(verdict.outcome),
    unitDigests: [],
  };
}
