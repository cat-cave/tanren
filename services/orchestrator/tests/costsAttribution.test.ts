import { describe, expect, it } from "vitest";
import {
  CostUnattributableError,
  classifyAuthRef,
  computeCostUsd,
  costSourceConstants,
  resolveCostSource
} from "../src/engine/costs/index.js";

describe("cost source attribution", () => {
  it("classifies a Codex ChatGPT subscription ref as codexbar", () => {
    expect(classifyAuthRef("credential/codex/team-prod")).toEqual({ kind: "codexbar" });
  });

  it("classifies an Anthropic API key ref as provider_direct", () => {
    expect(classifyAuthRef("credential/anthropic/prod")).toEqual({
      kind: "provider_direct",
      provider: "anthropic"
    });
  });

  it("classifies an OpenAI direct-API ref as provider_direct", () => {
    expect(classifyAuthRef("credential/openai-api/prod")).toEqual({
      kind: "provider_direct",
      provider: "openai"
    });
  });

  it("classifies a self-hosted endpoint ref as opportunity_computed", () => {
    expect(classifyAuthRef("credential/self-hosted/local-qwen")).toEqual({
      kind: "opportunity_computed",
      provider: "local-qwen"
    });
  });

  it("rejects an unrecognized credential prefix", () => {
    const result = classifyAuthRef("credential/legacy/whatever");
    expect(result.kind).toBe("unattributable");
  });

  it("resolves codexbar with subscription_window pricing", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: { foo: "bar" }
    });
    if (source.source !== "codexbar") {
      throw new Error(`expected codexbar, got ${source.source}`);
    }
    expect(source.pricingMode).toBe("subscription_window");
    expect(source.subscriptionMonthlyFee).toBe(costSourceConstants.codexbarSubscriptionMonthlyFeeUsd);
  });

  it("resolves provider_direct with the openai rate table", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/key1",
      rawUsage: {}
    });
    if (source.source !== "provider_direct") {
      throw new Error(`expected provider_direct, got ${source.source}`);
    }
    expect(source.provider).toBe("openai");
    expect(source.inputCostPerMillion).toBeGreaterThan(0);
  });

  it("requires runtimeSeconds for opportunity_computed attribution", () => {
    expect(() =>
      resolveCostSource({
        cli: "fake",
        authRef: "credential/self-hosted/qwen",
        rawUsage: {}
      })
    ).toThrow(CostUnattributableError);
  });

  it("resolves opportunity_computed with runtime seconds", () => {
    const source = resolveCostSource({
      cli: "fake",
      authRef: "credential/self-hosted/qwen",
      rawUsage: {},
      runtimeSeconds: 3600
    });
    if (source.source !== "opportunity_computed") {
      throw new Error(`expected opportunity_computed, got ${source.source}`);
    }
    expect(source.runtimeSeconds).toBe(3600);
  });

  it("throws CostUnattributableError when the auth ref matches no rule", () => {
    expect(() =>
      resolveCostSource({
        cli: "codex",
        authRef: "vault/secret/dev/random",
        rawUsage: {}
      })
    ).toThrow(CostUnattributableError);
  });

  it("throws CostUnattributableError on an empty auth ref", () => {
    expect(() =>
      resolveCostSource({
        cli: "codex",
        authRef: "",
        rawUsage: {}
      })
    ).toThrow(CostUnattributableError);
  });
});

describe("cost USD computation", () => {
  it("computes per_token cost using input + output rates", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      rawUsage: {}
    });
    const usd = computeCostUsd(source, { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 0 });
    // openai rate table: 2.5/in, 10/out -> 2.5 + 5 = 7.5
    expect(Number(usd)).toBeCloseTo(7.5, 5);
  });

  it("computes codexbar cost as fee/denominator * tokens", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: {},
      observedMaxMonthlyTokens: 1_000_000
    });
    const usd = computeCostUsd(source, { inputTokens: 100_000, outputTokens: 100_000, cachedTokens: 0 });
    // 20 / 1_000_000 * 200_000 = 4
    expect(Number(usd)).toBeCloseTo(4, 5);
  });

  it("computes opportunity_computed cost from runtime", () => {
    const source = resolveCostSource({
      cli: "fake",
      authRef: "credential/self-hosted/qwen",
      rawUsage: {},
      runtimeSeconds: 1800
    });
    // 0.5 USD/hour * 0.5 hour = 0.25
    expect(Number(computeCostUsd(source, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }))).toBeCloseTo(0.25, 5);
  });

  it("treats a zero denominator as zero cost for codexbar (no division by zero)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: {},
      observedMaxMonthlyTokens: 0
    });
    expect(Number(computeCostUsd(source, { inputTokens: 100, outputTokens: 100, cachedTokens: 0 }))).toBe(0);
  });
});
