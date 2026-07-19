// ds-4 sub-node #3 — the run-level design-render (a11y) verdict contract + the
// fail-closed aggregation over per-scenario checkpoints.
//
// The sub-node #1 harness renders a scenario and the sub-node #2 oracle judges its
// a11y audit; THIS module collapses the per-scenario oracle verdicts into ONE
// run-level outcome the native gate binds. It is deliberately PURE (no CAS, no DB,
// no render) so the aggregation truth table is unit-tested in isolation — the render
// orchestration (designSystemRenderVerification.ts) and the persistence
// (designRenderVerdictStore.ts) are the impure seams around it.

import type { RenderVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";

/** The run-level design-render outcome persisted + read by the land gate. */
export type DesignRenderRunOutcome = "passed" | "failed_visual" | "inconclusive_infrastructure" | "not_applicable";

/** One rendered-scenario checkpoint: the oracle verdict mapped to the gate vocabulary. */
export interface DesignRenderCheckpoint {
  readonly checkpointId: string;
  readonly verdict: "passed" | "failed" | "unknown";
  /** The real axe rule ids backing a `failed` verdict (evidence; empty otherwise). */
  readonly failingRuleIds: readonly string[];
}

/** The aggregated run-level verification result the producer persists. */
export interface DesignRenderVerification {
  readonly outcome: DesignRenderRunOutcome;
  readonly accessibilityStandard: string;
  readonly checkpoints: readonly DesignRenderCheckpoint[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly inconclusiveCount: number;
  /** Scenarios excluded because their component is NOT browser-free renderable (the
   * render-worker sub-node's job, e.g. an external-dep primitive that will not bundle).
   * Excluded scenarios are NOT checkpoints — they neither pass nor block. */
  readonly excludedCount: number;
  readonly failingScenarioKey: string | null;
  readonly failingRuleIds: readonly string[];
}

/** Map a sub-node #2 oracle outcome onto a checkpoint verdict (fail-closed: inconclusive → unknown). */
export function checkpointVerdictFromOracle(outcome: RenderVerdictOutcome): "passed" | "failed" | "unknown" {
  if (outcome === "passed") return "passed";
  if (outcome === "failed_visual") return "failed";
  return "unknown";
}

/**
 * FAIL-CLOSED aggregation of the per-scenario checkpoints into ONE run-level outcome:
 *   · ANY `failed` checkpoint          → `failed_visual` (a real a11y violation blocks).
 *   · else ANY `passed` checkpoint     → `passed` (verified at least one surface clean,
 *                                        none failed — the browser-free slice cleared).
 *   · else (nothing verifiable)        → `inconclusive_infrastructure` (every checkpoint
 *                                        was `unknown` OR every scenario was excluded — we
 *                                        could verify NOTHING → fail closed, never a pass).
 *
 * `excludedCount` records scenarios the browser-free harness cannot render (external-dep
 * primitives → the render-worker sub-node); they are neither a pass nor a block. A run
 * where EVERY scenario was excluded yields `inconclusive_infrastructure` (no checkpoint
 * verified), so a catalog that never renders browser-free fails closed rather than passing.
 */
export function aggregateDesignRenderOutcome(
  accessibilityStandard: string,
  checkpoints: readonly DesignRenderCheckpoint[],
  excludedCount: number,
): DesignRenderVerification {
  const passedCount = checkpoints.filter((c) => c.verdict === "passed").length;
  const failedCount = checkpoints.filter((c) => c.verdict === "failed").length;
  const inconclusiveCount = checkpoints.filter((c) => c.verdict === "unknown").length;

  const firstFailed = checkpoints.find((c) => c.verdict === "failed");
  const outcome: DesignRenderRunOutcome =
    firstFailed === undefined ? (passedCount > 0 ? "passed" : "inconclusive_infrastructure") : "failed_visual";

  return {
    outcome,
    accessibilityStandard,
    checkpoints,
    passedCount,
    failedCount,
    inconclusiveCount,
    excludedCount,
    failingScenarioKey: firstFailed?.checkpointId ?? null,
    failingRuleIds: firstFailed === undefined ? [] : [...firstFailed.failingRuleIds],
  };
}

/** The `not_applicable` verification — an advisory posture ("none"): design exists but no a11y bar. */
export function notApplicableDesignRenderVerification(accessibilityStandard: string): DesignRenderVerification {
  return {
    outcome: "not_applicable",
    accessibilityStandard,
    checkpoints: [],
    passedCount: 0,
    failedCount: 0,
    inconclusiveCount: 0,
    excludedCount: 0,
    failingScenarioKey: null,
    failingRuleIds: [],
  };
}
