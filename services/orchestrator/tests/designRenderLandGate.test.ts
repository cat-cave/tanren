// ds-4 sub-node #3 — the DB-less fail-closed decision table for the design-render land gate
// + the gate-proof section mapper. The org-scoped SQL read is pinned in the *.rls.integration
// test; this pins the classifier + the GateProofBundleV2 `design_render` body/verdict mapping.

import { describe, expect, it } from "vitest";
import { evaluateDesignRenderLandGate } from "../src/engine/merge/designRenderLandGate.js";
import type { DesignRenderVerdictRow } from "../src/engine/design/render/designRenderVerdictStore.js";
import {
  designRenderGateSection,
  designRenderProofBody,
  designRenderSectionVerdict,
} from "../src/engine/design/render/designRenderGateProof.js";

function row(overrides: Partial<DesignRenderVerdictRow>): DesignRenderVerdictRow {
  return {
    outcome: "passed",
    accessibilityStandard: "wcag-2.2-aa",
    designContractVersion: "3",
    releaseId: "design_web_release_x",
    contractDigest: "sha256:deadbeef",
    failingScenarioKey: null,
    failingRuleIds: [],
    checkpointCount: 1,
    checkpoints: [{ checkpointId: "button:light:desktop:en-US", verdict: "passed", failingRuleIds: [] }],
    ...overrides,
  };
}

describe("evaluateDesignRenderLandGate — fail-closed classifier", () => {
  it("no verdict + no published system → not_applicable (design was not required)", () => {
    expect(evaluateDesignRenderLandGate({ verdict: undefined, hasPublishedSystemWithoutVerdict: false })).toEqual({
      kind: "not_applicable",
    });
  });

  it("no verdict + a PUBLISHED design system → inconclusive (required-but-absent, fail closed)", () => {
    expect(evaluateDesignRenderLandGate({ verdict: undefined, hasPublishedSystemWithoutVerdict: true }).kind).toBe(
      "inconclusive",
    );
  });

  it("outcome not_applicable → not_applicable (advisory posture never blocks)", () => {
    expect(
      evaluateDesignRenderLandGate({
        verdict: row({ outcome: "not_applicable" }),
        hasPublishedSystemWithoutVerdict: false,
      }),
    ).toEqual({ kind: "not_applicable" });
  });

  it("outcome passed → passed, counting the passing checkpoints", () => {
    const gate = evaluateDesignRenderLandGate({
      verdict: row({ outcome: "passed" }),
      hasPublishedSystemWithoutVerdict: false,
    });
    expect(gate).toEqual({ kind: "passed", passedCheckpointCount: 1 });
  });

  it("outcome failed_visual → failed, carrying the failing scenario + rule ids", () => {
    const gate = evaluateDesignRenderLandGate({
      verdict: row({
        outcome: "failed_visual",
        failingScenarioKey: "button:dark:mobile:en-US",
        failingRuleIds: ["button-name"],
      }),
      hasPublishedSystemWithoutVerdict: false,
    });
    expect(gate).toEqual({
      kind: "failed",
      failingScenarioKey: "button:dark:mobile:en-US",
      failingRuleIds: ["button-name"],
    });
  });

  it("outcome inconclusive_infrastructure → inconclusive (fail closed; inconclusive ≠ passed)", () => {
    expect(
      evaluateDesignRenderLandGate({
        verdict: row({ outcome: "inconclusive_infrastructure" }),
        hasPublishedSystemWithoutVerdict: false,
      }).kind,
    ).toBe("inconclusive");
  });
});

describe("design_render gate-proof section mapping", () => {
  it("section verdict maps passed→passed, failed_visual→failed, else→unknown (fail closed)", () => {
    expect(designRenderSectionVerdict("passed")).toBe("passed");
    expect(designRenderSectionVerdict("failed_visual")).toBe("failed");
    expect(designRenderSectionVerdict("inconclusive_infrastructure")).toBe("unknown");
    expect(designRenderSectionVerdict("not_applicable")).toBe("unknown");
  });

  it("builds a DesignRenderBody WITHOUT a fabricated diffRatio (a11y path omits pixel diff)", () => {
    const body = designRenderProofBody(
      row({
        checkpoints: [
          { checkpointId: "button:light:desktop:en-US", verdict: "passed", failingRuleIds: [] },
          { checkpointId: "button:dark:mobile:en-US", verdict: "failed", failingRuleIds: ["button-name"] },
        ],
      }),
    );
    expect(body.designContractVersions).toEqual(["3"]);
    expect(body.checkpointCount).toBe(2);
    for (const verdict of body.renderVerdicts) {
      expect(verdict.diffRatio).toBeUndefined();
    }
  });

  it("builds a required design_render section verdict from the row", () => {
    const section = designRenderGateSection(row({ outcome: "failed_visual" }), true);
    expect(section).toEqual({ kind: "design_render", required: true, verdict: "failed", unitDigests: [] });
  });
});
