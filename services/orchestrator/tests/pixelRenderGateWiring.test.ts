// ds-4 Slice B sub-node #3 — proves the REAL pixel diffRatio flows into the native
// design_render gate body. A pixel verdict → a shared checkpoint (carrying the real
// diffRatio) → `designRenderProofBody` emits `renderVerdicts[].diffRatio` and the body
// passes `DesignRenderBodySchema`; a `failed_visual` pixel verdict maps to a `failed`
// checkpoint → `failed` gate section (blocks). The a11y path (no diffRatio) still omits
// the field. This is the gate omission the node closes.

import { describe, expect, it } from "vitest";
import { DesignRenderBodySchema } from "../src/engine/contracts/gateProof.js";
import { designRenderGateSection, designRenderProofBody } from "../src/engine/design/render/designRenderGateProof.js";
import { aggregateDesignRenderOutcome } from "../src/engine/design/render/designRenderVerdict.js";
import { checkpointFromPixelVerdict } from "../src/engine/design/render/pixelRenderCheckpoint.js";
import type { DesignRenderVerdictRow } from "../src/engine/design/render/designRenderVerdictStore.js";
import type { PixelRenderVerdict } from "../src/engine/design/render/visualDiffOracle.js";

function pixelVerdict(over: Partial<PixelRenderVerdict>): PixelRenderVerdict {
  return {
    outcome: "passed",
    scenarioKey: "button:light:desktop",
    designContractVersion: "dcv_1",
    diffRatio: 0,
    threshold: 0.01,
    screenshotDigest: null,
    baselineDigest: null,
    diffArtifactDigest: null,
    mismatchedPixels: 0,
    totalPixels: 4096,
    reason: null,
    ...over,
  };
}

function rowFrom(checkpoints: ReturnType<typeof checkpointFromPixelVerdict>[]): DesignRenderVerdictRow {
  const verification = aggregateDesignRenderOutcome("wcag-2.2-aa", checkpoints, 0);
  return {
    outcome: verification.outcome,
    accessibilityStandard: verification.accessibilityStandard,
    designContractVersion: "dcv_1",
    releaseId: "release_1",
    contractDigest: `sha256:${"a".repeat(64)}`,
    failingScenarioKey: verification.failingScenarioKey,
    failingRuleIds: verification.failingRuleIds,
    checkpointCount: verification.checkpoints.length,
    checkpoints: verification.checkpoints,
  };
}

describe("ds-4 Slice B — pixel diffRatio → design_render gate wiring", () => {
  it("a passing pixel verdict → the gate body carries the REAL diffRatio (schema-valid)", () => {
    const checkpoint = checkpointFromPixelVerdict(pixelVerdict({ outcome: "passed", diffRatio: 0.004 }));
    expect(checkpoint.verdict).toBe("passed");
    expect(checkpoint.diffRatio).toBe(0.004);

    const row = rowFrom([checkpoint]);
    expect(row.outcome).toBe("passed");

    const body = designRenderProofBody(row);
    // The body validates against the real design_render schema AND carries the diffRatio.
    const parsed = DesignRenderBodySchema.parse(body);
    expect(parsed.renderVerdicts).toHaveLength(1);
    expect(parsed.renderVerdicts[0]?.diffRatio).toBe(0.004);
    expect(parsed.renderVerdicts[0]?.verdict).toBe("passed");
  });

  it("a failed_visual pixel verdict → failed checkpoint → failed gate section (blocks)", () => {
    const checkpoint = checkpointFromPixelVerdict(pixelVerdict({ outcome: "failed_visual", diffRatio: 0.25 }));
    expect(checkpoint.verdict).toBe("failed");
    expect(checkpoint.diffRatio).toBe(0.25);

    const row = rowFrom([checkpoint]);
    expect(row.outcome).toBe("failed_visual");

    const body = DesignRenderBodySchema.parse(designRenderProofBody(row));
    expect(body.renderVerdicts[0]?.diffRatio).toBe(0.25);

    const section = designRenderGateSection(row, true);
    expect(section.verdict).toBe("failed");
  });

  it("an inconclusive pixel verdict → unknown checkpoint, NO diffRatio (blocks, never a fake ratio)", () => {
    const checkpoint = checkpointFromPixelVerdict(
      pixelVerdict({ outcome: "inconclusive_infrastructure", diffRatio: null }),
    );
    expect(checkpoint.verdict).toBe("unknown");
    expect(checkpoint.diffRatio).toBeUndefined();

    const row = rowFrom([checkpoint]);
    expect(row.outcome).toBe("inconclusive_infrastructure");

    const body = DesignRenderBodySchema.parse(designRenderProofBody(row));
    expect(body.renderVerdicts[0]).not.toHaveProperty("diffRatio");
    expect(designRenderGateSection(row, true).verdict).toBe("unknown");
  });

  it("the a11y path (no diffRatio) still omits the field from the gate body", () => {
    const row = rowFrom([{ checkpointId: "button:aa", verdict: "passed", failingRuleIds: [] }]);
    const body = DesignRenderBodySchema.parse(designRenderProofBody(row));
    expect(body.renderVerdicts[0]).not.toHaveProperty("diffRatio");
  });
});
