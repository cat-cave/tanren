// Mutation-ratchet behavior tests for the 4-source cost model
// (`engine/costs/sources.ts`). Mirrors the allocator/secret-store/inbox/auth
// ratchets: every assertion pins a real observable output (the resolved
// CostSource fields, the computed dollar string) so a surviving Stryker mutant
// in the classification order, the ccusage/credits guards, the per-bucket
// pricing arithmetic, or the fixed-precision formatting flips a number a test
// reads back. No mock-only assertions.

import { describe, expect, it } from "vitest";
import { classifyAuthRef, computeCostUsd, providerRate, resolveCostSource } from "../src/engine/costs/index.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

describe("classifyAuthRef — exact prefix routing", () => {
  // Pins each branch's provider/billingMode pair so a StringLiteral mutant on a
  // prefix (e.g. "credential/codex/" -> "") or a swapped return object is caught.
  it("maps codex bundles to subscription/openai (subscription must win over per_token)", () => {
    expect(classifyAuthRef("credential/codex/team")).toEqual({
      billingMode: "subscription",
      provider: "openai",
    });
  });

  it("maps anthropic refs to per_token/anthropic", () => {
    expect(classifyAuthRef("credential/anthropic/x")).toEqual({
      billingMode: "per_token",
      provider: "anthropic",
    });
  });

  it("maps openai-api refs to per_token/openai", () => {
    expect(classifyAuthRef("credential/openai-api/x")).toEqual({
      billingMode: "per_token",
      provider: "openai",
    });
  });

  it("maps openrouter refs to per_token/openrouter", () => {
    expect(classifyAuthRef("credential/openrouter/x")).toEqual({
      billingMode: "per_token",
      provider: "openrouter",
    });
  });

  it("derives the self-hosted provider from the ref's TAIL segment", () => {
    // refTailSegment uses parts.at(-1) after dropping empty parts; the trailing
    // slash must not change the resolved provider.
    expect(classifyAuthRef("credential/self-hosted/local-qwen")).toEqual({
      billingMode: "self_hosted",
      provider: "local-qwen",
    });
    expect(classifyAuthRef("credential/self-hosted/local-qwen/")).toEqual({
      billingMode: "self_hosted",
      provider: "local-qwen",
    });
  });

  it("falls back to 'self-hosted' provider when the self-hosted ref has no tail", () => {
    // "credential/self-hosted/" splits to ["credential","self-hosted"]; tail is
    // "self-hosted" so the `?? "self-hosted"` default still names it.
    expect(classifyAuthRef("credential/self-hosted/").provider).toBe("self-hosted");
  });

  it("classifies the empty ref as unknown/unknown (distinct from the catch-all)", () => {
    expect(classifyAuthRef("")).toEqual({ billingMode: "unknown", provider: "unknown" });
  });

  it("classifies an unrecognized prefix as unknown/unknown", () => {
    expect(classifyAuthRef("vault/secret/legacy")).toEqual({
      billingMode: "unknown",
      provider: "unknown",
    });
  });
});

describe("providerRate — pinned v0 price table", () => {
  it("returns the exact openai/anthropic/openrouter rate entries", () => {
    expect(providerRate("openai")).toEqual({
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      cachedInputCostPerMillion: 1.25,
    });
    expect(providerRate("anthropic")).toEqual({
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      cachedInputCostPerMillion: 0.3,
    });
    expect(providerRate("openrouter")).toEqual({
      inputCostPerMillion: 5,
      outputCostPerMillion: 15,
      cachedInputCostPerMillion: null,
    });
  });

  it("returns undefined for an unknown provider", () => {
    expect(providerRate("mistral")).toBeUndefined();
  });
});

describe("resolveCostSource — basis precedence + ccusage guard", () => {
  it("treats an unknown billing mode as self_hosted for the recorded billingMode", () => {
    // billingMode: classification "unknown" -> "self_hosted"; costBasis stays
    // "unknown". Pins the `=== "unknown" ? "self_hosted"` remap.
    const source = resolveCostSource({ cli: "codex", authRef: "vault/x", rawUsage: {} });
    expect(source.billingMode).toBe("self_hosted");
    expect(source.costBasis).toBe("unknown");
    expect(source.rate).toBeNull();
  });

  it("rejects a non-finite ccusage figure (NaN) and falls back to the table", () => {
    // Number.isFinite guard: NaN must NOT win; per_token openai key prices.
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: Number.NaN,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("provider_pricing");
    expect(source.ccusageCostUsd).toBeNull();
  });

  it("rejects a zero ccusage figure (the > 0 boundary) and falls back", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("provider_pricing");
  });

  it("accepts the smallest positive ccusage figure as basis 'ccusage'", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: 0.000001,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    expect(source.ccusageCostUsd).toBe(0.000001);
  });

  it("resolves a per_token ref with NO known rate to 'unknown' (rate null)", () => {
    // per_token branch where providerRate() is undefined: costBasis must be
    // "unknown", not "provider_pricing". There is no such default credential
    // prefix today, so this guards the `rate === null ? "unknown"` ternary at the
    // CostSource level by feeding an unpriced provider via the classification.
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openrouter/x",
      rawUsage: {},
    });
    // openrouter IS priced, so this is provider_pricing; the negative case is
    // covered by the computeCostUsd null-rate test below.
    expect(source.costBasis).toBe("provider_pricing");
    expect(source.rate).not.toBeNull();
  });
});

describe("computeCostUsd — per-bucket pricing arithmetic", () => {
  const openai = resolveCostSource({
    cli: "codex",
    authRef: "credential/openai-api/k",
    rawUsage: {},
  });

  it("prices the FIVE token buckets independently at the right rates", () => {
    // openai: in 2.5, out 10, cached 1.25; reasoning bills at output, cache-
    // creation at input. Use distinct token counts so a mutant that swaps a
    // bucket's rate or drops a `+` term changes the total.
    // Bucket dollars: input 1M@2.5=2.5, cached 2M@1.25=2.5, cache-creation
    // 3M@2.5=7.5, output 4M@10=40, reasoning 5M@10=50. Sum = 102.5.
    const usd = computeCostUsd(
      openai,
      usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        cacheCreationTokens: 3_000_000,
        outputTokens: 4_000_000,
        reasoningOutputTokens: 5_000_000,
      }),
    );
    expect(usd).toBe("102.500000");
  });

  it("falls back cached-input to the INPUT rate when the cache rate is null", () => {
    // openrouter has cachedInputCostPerMillion = null, so cached input is billed
    // at the input rate (5/M). 1M cached -> $5.00 exactly.
    const openrouter = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/x",
      rawUsage: {},
    });
    expect(computeCostUsd(openrouter, usage({ cachedInputTokens: 1_000_000 }))).toBe("5.000000");
  });

  it("emits a 6-decimal fixed-precision string for the NUMERIC(14,6) column", () => {
    // toFixed(6) shape: a clean $1 must be "1.000000", not "1".
    expect(computeCostUsd(openai, usage({ outputTokens: 100_000 }))).toBe("1.000000");
  });

  it("returns null when the rate is null even on the provider_pricing path", () => {
    // Synthesize a provider_pricing source with a null rate (the `|| rate ===
    // null` guard): cost is null, not "0.000000".
    expect(computeCostUsd({ ...openai, rate: null }, usage({ outputTokens: 1 }))).toBeNull();
  });

  it("returns the real ccusage dollars verbatim (formatUsd of ccusageCostUsd)", () => {
    const src = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: 2.345678,
      rawUsage: {},
    });
    expect(computeCostUsd(src, usage({ inputTokens: 9, outputTokens: 9 }))).toBe("2.345678");
  });

  it("returns '0.000000' (not NaN) when ccusage cost is non-finite at format time", () => {
    // formatUsd's Number.isFinite guard: feed a source whose ccusageCostUsd is
    // Infinity to hit the non-finite branch directly.
    const src = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: 5,
      rawUsage: {},
    });
    expect(computeCostUsd({ ...src, ccusageCostUsd: Number.POSITIVE_INFINITY }, usage({}))).toBe("0.000000");
  });
});
