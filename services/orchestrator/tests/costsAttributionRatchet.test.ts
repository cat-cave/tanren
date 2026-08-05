// Mutation-ratchet behavior tests for the cost model (`engine/costs/sources.ts`).
// Mirrors the allocator/secret-store/inbox/auth ratchets: every assertion pins a
// real observable output (the resolved CostSource fields, the computed dollar
// string) so a surviving Stryker mutant in the classification order, the
// real-spend FACT guards, the notional model-price arithmetic, or the
// fixed-precision formatting flips a number a test reads back. No mock-only
// assertions. REAL SPEND IS A FACT: cost_usd is a metered fact-or-NULL (no table);
// NOTIONAL is a SEPARATE figure computed from the maintained LiteLLM model price.

import { describe, expect, it } from "vitest";
import { classifyAuthRef, computeCostUsd, computeNotionalUsd, resolveCostSource } from "../src/engine/costs/index.js";
import { ModelPriceSource, type ModelPriceMap } from "../src/engine/costs/pricing/modelPriceSource.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

// The five buckets are DISJOINT and sum to totalTokens (see TokenUsage: "provider
// -reported total, else sum of the five"). A fixture that sets buckets but leaves
// the total at 0 describes an impossible call, and the notional path now reads the
// total (a zero-token call is `no_tokens`, not an unpriced model) — so derive the
// total from the buckets unless a test states one explicitly.
function usage(partial: Partial<TokenUsage>): TokenUsage {
  const buckets = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...partial,
  };
  return {
    ...buckets,
    totalTokens:
      partial.totalTokens ??
      buckets.inputTokens +
        buckets.cachedInputTokens +
        buckets.cacheCreationTokens +
        buckets.outputTokens +
        buckets.reasoningOutputTokens,
  };
}

// Injected price map (cost PER TOKEN, LiteLLM-shaped). `ratchet-model`: 2.5/M in,
// 10/M out, 1.25/M cache-read; no cache-creation axis (→ input rate stands in).
const fixturePriceMap: ModelPriceMap = {
  "ratchet-model": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
  },
};
const priceSource = new ModelPriceSource(fixturePriceMap);

describe("classifyAuthRef — exact prefix routing", () => {
  it("maps codex bundles to subscription/openai (subscription must win over per_token)", () => {
    expect(classifyAuthRef("credential/codex/team")).toEqual({ billingMode: "subscription", provider: "openai" });
  });

  it("maps anthropic refs to per_token/anthropic", () => {
    expect(classifyAuthRef("credential/anthropic/x")).toEqual({ billingMode: "per_token", provider: "anthropic" });
  });

  it("maps openai-api refs to per_token/openai", () => {
    expect(classifyAuthRef("credential/openai-api/x")).toEqual({ billingMode: "per_token", provider: "openai" });
  });

  it("maps openrouter refs to per_token/openrouter", () => {
    expect(classifyAuthRef("credential/openrouter/x")).toEqual({ billingMode: "per_token", provider: "openrouter" });
  });

  it("derives the self-hosted provider from the ref's TAIL segment", () => {
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
    expect(classifyAuthRef("credential/self-hosted/").provider).toBe("self-hosted");
  });

  it("classifies the empty ref as 'absent'/unknown (the no-credential path, distinct from the catch-all)", () => {
    expect(classifyAuthRef("")).toEqual({ billingMode: "absent", provider: "unknown" });
  });

  it("BUDGET-SAFETY C1: classifies an unrecognized non-empty prefix as 'unrecognized' with a secret-free refKind", () => {
    expect(classifyAuthRef("vault/secret/legacy")).toEqual({
      billingMode: "unrecognized",
      provider: "unknown",
      refKind: "vault/secret",
    });
  });
});

describe("resolveCostSource — real-spend FACT precedence + guards", () => {
  it("BUDGET-SAFETY C1: records an unrecognized ref as 'unattributed' (NOT silently self_hosted/$0)", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "vault/x", rawUsage: {} });
    expect(source.billingMode).toBe("unattributed");
    expect(source.costBasis).toBe("unattributed");
    expect(source.unattributedRefKind).toBe("vault");
  });

  it("rejects a non-finite ccusage figure (NaN) and, with no other fact, is honest-null", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: Number.NaN,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("unknown");
    expect(source.ccusageCostUsd).toBeNull();
  });

  it("rejects a zero ccusage figure (the > 0 boundary) and is honest-null", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("unknown");
  });

  it("accepts the smallest positive ccusage figure as basis 'ccusage' (a real FACT)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0.000001,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    expect(source.ccusageCostUsd).toBe(0.000001);
  });

  it("accepts the smallest positive provider_response figure as basis 'provider_response' (OUTRANKS ccusage)", () => {
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/x",
      realProviderCostUsd: 0.000001,
      ccusageCostUsd: 5,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("provider_response");
    expect(source.realProviderCostUsd).toBe(0.000001);
    expect(source.ccusageCostUsd).toBeNull();
  });

  it("a per_token ref with NO captured fact resolves to 'unknown' (no static table to fall back to)", () => {
    const source = resolveCostSource({ cli: "aider", authRef: "credential/openrouter/x", rawUsage: {} });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("unknown");
  });
});

describe("computeCostUsd — real-spend FACT only", () => {
  it("returns the provider_response figure verbatim (6-decimal fixed precision)", () => {
    const src = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/x",
      realProviderCostUsd: 1,
      rawUsage: {},
    });
    expect(computeCostUsd(src, usage({ inputTokens: 9_999_999 }))).toBe("1.000000");
  });

  it("returns the real ccusage dollars verbatim (formatUsd of ccusageCostUsd)", () => {
    const src = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 2.345678,
      rawUsage: {},
    });
    expect(computeCostUsd(src, usage({ inputTokens: 9, outputTokens: 9 }))).toBe("2.345678");
  });

  it("returns null for a per_token call with no fact (NO list-rate table)", () => {
    const src = resolveCostSource({ cli: "codex", authRef: "credential/openai-api/k", rawUsage: {} });
    expect(computeCostUsd(src, usage({ outputTokens: 100_000 }))).toBeNull();
  });

  it("returns '0.000000' (not NaN) when a real figure is non-finite at format time", () => {
    const src = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 5,
      rawUsage: {},
    });
    expect(computeCostUsd({ ...src, ccusageCostUsd: Number.POSITIVE_INFINITY }, usage({}))).toBe("0.000000");
  });
});

describe("computeNotionalUsd — per-bucket model-price arithmetic", () => {
  const src = resolveCostSource({
    cli: "codex",
    authRef: "credential/openai-api/k",
    model: "ratchet-model",
    rawUsage: {},
  });

  it("prices the FIVE token buckets independently at the model's rates", () => {
    // ratchet-model: in 2.5, out 10, cache-read 1.25; reasoning bills at output,
    // cache-creation at input (no cache-creation axis → input rate stands in).
    // Bucket dollars: input 1M@2.5=2.5, cached 2M@1.25=2.5, cache-creation
    // 3M@2.5=7.5, output 4M@10=40, reasoning 5M@10=50. Sum = 102.5.
    const notional = computeNotionalUsd(
      src,
      usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        cacheCreationTokens: 3_000_000,
        outputTokens: 4_000_000,
        reasoningOutputTokens: 5_000_000,
      }),
      priceSource,
    );
    expect(notional).toEqual({ usd: "102.500000", reason: "priced" });
  });

  it("emits a 6-decimal fixed-precision string", () => {
    expect(computeNotionalUsd(src, usage({ outputTokens: 100_000 }), priceSource)).toEqual({
      usd: "1.000000",
      reason: "priced",
    });
  });

  it("returns null when the model is not in the price source (LOUD-unknown, no guess)", () => {
    const unknown = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "not-in-source",
      rawUsage: {},
    });
    // The source WAS consultable, so the null blames the MODEL, not the source. A
    // mutant that flipped the health check would say `price_source_unavailable`.
    expect(priceSource.health()).toBe("ready");
    expect(computeNotionalUsd(unknown, usage({ outputTokens: 1 }), priceSource)).toEqual({
      usd: null,
      reason: "model_not_listed",
    });
  });

  it("blames the SOURCE, not the model, when no price source could be consulted", () => {
    // An EMPTY table is a source that cannot answer anything (health 'unavailable').
    // Same null, categorically different reason: recoverable by a later reprice.
    const emptySource = new ModelPriceSource({});
    expect(emptySource.health()).toBe("unavailable");
    expect(computeNotionalUsd(src, usage({ outputTokens: 100_000 }), emptySource)).toEqual({
      usd: null,
      reason: "price_source_unavailable",
    });
  });

  it("reports a zero-token call as legitimately empty, never as an unpriced model", () => {
    // Nothing to price is NOT a pricing gap: a priceable model with no tokens must
    // not pollute the loud unpriced signal.
    expect(computeNotionalUsd(src, usage({}), priceSource)).toEqual({ usd: null, reason: "no_tokens" });
  });

  it("prefers a positive ccusage figure over the model price (and emits it verbatim)", () => {
    const withCcusage = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      model: "ratchet-model",
      ccusageCostUsd: 2.345678,
      rawUsage: {},
    });
    expect(computeNotionalUsd(withCcusage, usage({ outputTokens: 100_000 }), priceSource)).toEqual({
      usd: "2.345678",
      reason: "ccusage",
    });
  });
});
