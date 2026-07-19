import { describe, expect, it } from "vitest";
import type { DesignRenderVerdictRow } from "../src/engine/design/render/designRenderVerdictStore.js";
import type { DesignRenderCheckpoint } from "../src/engine/design/render/designRenderVerdict.js";
import type { BehaviorVerdictOutcome } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import {
  applyVisualGate,
  DesignRenderAcceptanceStage,
  evaluateVisualContribution,
  type DesignRenderVerdictReader,
} from "../src/engine/verification/acceptance/designRenderStage.js";

function checkpoint(id: string, verdict: DesignRenderCheckpoint["verdict"]): DesignRenderCheckpoint {
  return { checkpointId: id, verdict, failingRuleIds: verdict === "failed" ? ["color-contrast"] : [] };
}

function row(overrides: Partial<DesignRenderVerdictRow>): DesignRenderVerdictRow {
  return {
    outcome: "passed",
    accessibilityStandard: "wcag21aa",
    designContractVersion: "v2",
    releaseId: "rel_1",
    contractDigest: "sha256:abc",
    failingScenarioKey: null,
    failingRuleIds: [],
    checkpointCount: 1,
    checkpoints: [checkpoint("home", "passed")],
    ...overrides,
  };
}

describe("evaluateVisualContribution — fail-closed truth table (rv-13)", () => {
  it("a passed verdict clears with its passed-checkpoint count", () => {
    const contribution = evaluateVisualContribution(
      row({ outcome: "passed", checkpoints: [checkpoint("home", "passed"), checkpoint("about", "passed")] }),
    );
    expect(contribution).toEqual({ kind: "passed", passedCheckpointCount: 2 });
  });

  it("a failed_visual verdict blocks with its failing scenario + rule ids", () => {
    const contribution = evaluateVisualContribution(
      row({ outcome: "failed_visual", failingScenarioKey: "checkout", failingRuleIds: ["color-contrast", "label"] }),
    );
    expect(contribution).toEqual({
      kind: "failed_visual",
      failingScenarioKey: "checkout",
      failingRuleIds: ["color-contrast", "label"],
    });
  });

  it("an inconclusive_infrastructure verdict is inconclusive (blocks)", () => {
    const contribution = evaluateVisualContribution(row({ outcome: "inconclusive_infrastructure" }));
    expect(contribution.kind).toBe("inconclusive");
  });

  it("a not_applicable verdict for a REQUIRED visual behavior is inconclusive — an absent bar cannot satisfy the demand", () => {
    const contribution = evaluateVisualContribution(row({ outcome: "not_applicable", accessibilityStandard: "none" }));
    expect(contribution.kind).toBe("inconclusive");
  });

  it("an ABSENT verdict (required-but-absent) is inconclusive, never a pass", () => {
    const absent: DesignRenderVerdictRow | undefined = undefined;
    const contribution = evaluateVisualContribution(absent);
    expect(contribution.kind).toBe("inconclusive");
  });
});

describe("applyVisualGate — downgrade-only overlay (rv-13)", () => {
  const passed = { kind: "passed", passedCheckpointCount: 1 } as const;
  const failedVisual = { kind: "failed_visual", failingScenarioKey: "home", failingRuleIds: ["x"] } as const;
  const inconclusive = { kind: "inconclusive", reason: "r" } as const;

  it("a passing behavior stays passed only when the visual verdict also passed", () => {
    expect(applyVisualGate("passed", passed)).toBe("passed");
  });

  it("a passing behavior is downgraded to failed_visual on a failed render", () => {
    expect(applyVisualGate("passed", failedVisual)).toBe("failed_visual");
  });

  it("a passing behavior is downgraded to inconclusive on an inconclusive render", () => {
    expect(applyVisualGate("passed", inconclusive)).toBe("inconclusive_infrastructure");
  });

  it("NEVER rescues a non-pass into a pass (a failed_product stays failed even if visual passed)", () => {
    expect(applyVisualGate("failed_product", passed)).toBe("failed_product");
    const outcomes: BehaviorVerdictOutcome[] = ["failed_product", "failed_verification_contract"];
    for (const base of outcomes) {
      expect(applyVisualGate(base, passed)).toBe(base);
      expect(applyVisualGate(base, failedVisual)).toBe(base);
      expect(applyVisualGate(base, inconclusive)).toBe(base);
    }
  });

  it("a real failed_visual is more decisive than an infra-inconclusive base", () => {
    expect(applyVisualGate("inconclusive_infrastructure", failedVisual)).toBe("failed_visual");
    expect(applyVisualGate("inconclusive_external", failedVisual)).toBe("failed_visual");
  });
});

describe("DesignRenderAcceptanceStage — fail-closed resolution (rv-13)", () => {
  const input = { orgId: "org_1", projectId: "project_1", requirement: { required: true } } as const;

  it("blocks (inconclusive) when NO reader is wired — unresolved is never a pass", async () => {
    const stage = new DesignRenderAcceptanceStage(undefined);
    const contribution = await stage.resolve(input);
    expect(contribution.kind).toBe("inconclusive");
  });

  it("blocks (inconclusive) when the reader RAISES", async () => {
    const reader: DesignRenderVerdictReader = {
      readLatest: () => Promise.reject(new Error("db down")),
    };
    const stage = new DesignRenderAcceptanceStage(reader);
    const contribution = await stage.resolve(input);
    expect(contribution.kind).toBe("inconclusive");
    expect(contribution.kind === "inconclusive" && contribution.reason).toContain("db down");
  });

  it("passes through the persisted verdict for a decisive pass", async () => {
    const reader: DesignRenderVerdictReader = {
      readLatest: () => Promise.resolve(row({ outcome: "passed" })),
    };
    const stage = new DesignRenderAcceptanceStage(reader);
    const contribution = await stage.resolve(input);
    expect(contribution.kind).toBe("passed");
  });
});
