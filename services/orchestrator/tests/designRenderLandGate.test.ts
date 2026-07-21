// ds-4 sub-node #3 — the DB-less fail-closed decision table for the design-render land gate
// + the gate-proof section mapper. The org-scoped SQL read is pinned in the *.rls.integration
// test; this pins the classifier + the GateProofBundleV2 `design_render` body/verdict mapping.

import { describe, expect, it } from "vitest";
import {
  evaluateDesignRenderLandGate,
  evaluateRequiredTargetConformance,
} from "../src/engine/merge/designRenderLandGate.js";
import {
  designAdapterConformanceReceiptDigest,
  type DesignAdapterConformanceReceiptV1,
} from "../src/engine/design/system/adapterConformanceReceipt.js";
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

const DIGEST = `sha256:${"a".repeat(64)}`;

function passedReceipt(): DesignAdapterConformanceReceiptV1 {
  return {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: "web-react",
    adapterVersion: "tanren.web-react.v1",
    artifactDigest: DIGEST,
    scenarioMatrixDigest: DIGEST,
    requiredCapabilities: ["css-variables"],
    resolvedCapabilities: [{ capability: "css-variables", supported: true, evidenceDigest: DIGEST }],
    criticalProofs: [{ key: "web-react.build", kind: "build", evidenceDigest: DIGEST, passed: true }],
    positiveCases: [{ key: "web-react.tokens", description: "tokens", evidenceDigest: DIGEST, passed: true }],
    negativeControls: [
      { key: "web-react.tokens-missing", description: "missing", expectFindingCode: "web.missing", passed: true },
    ],
    outcome: "passed",
    notes: "",
  };
}

function receiptRow(
  overrides: Partial<{ receipt: unknown; outcome: string; artifactDigest: string; persistedDigest: string }> = {},
) {
  const validReceipt = passedReceipt();
  const receipt = overrides.receipt ?? validReceipt;
  return {
    target: "web-react",
    artifact_digest: overrides.artifactDigest ?? DIGEST,
    persisted_artifact_digest: overrides.persistedDigest ?? DIGEST,
    // A corrupt JSON body is an adversarial persisted mutation: retain the
    // digest of the original valid body so the gate reaches its body parser.
    receipt_digest: designAdapterConformanceReceiptDigest(validReceipt),
    receipt,
    outcome: overrides.outcome ?? "passed",
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
      "inconclusive_infrastructure",
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
    ).toBe("inconclusive_infrastructure");
  });
});

describe("evaluateRequiredTargetConformance — DB-free receipt binding", () => {
  const required = [{ target: "web-react", capabilities: ["css-variables"] }] as const;

  it("accepts only a passed receipt on the exact target artifact + contract capabilities", () => {
    expect(evaluateRequiredTargetConformance(required, [receiptRow()])).toEqual({
      kind: "passed",
      hasPublishedRelease: true,
    });
  });

  it.each([
    ["absent", [], "has no design-adapter conformance receipt"],
    ["failed", [receiptRow({ outcome: "failed" })], "recorded 'failed'"],
    ["corrupt", [receiptRow({ receipt: { corrupt: true } })], "receipt is corrupt"],
    ["stale", [receiptRow({ persistedDigest: `sha256:${"b".repeat(64)}` })], "receipt artifact digest is stale"],
  ])("fail-closes %s conformance evidence", (_name, rows, reason) => {
    const result = evaluateRequiredTargetConformance(required, rows);
    expect(result).toMatchObject({ kind: "inconclusive" });
    expect(result.kind === "inconclusive" && result.reason).toContain(reason);
  });

  it("fail-closes a receipt whose required capability set does not equal the V2 contract", () => {
    const result = evaluateRequiredTargetConformance(
      [{ target: "web-react", capabilities: ["tailwind"] }],
      [receiptRow()],
    );
    expect(result).toMatchObject({ kind: "inconclusive" });
    expect(result.kind === "inconclusive" && result.reason).toContain("capability set does not match");
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
