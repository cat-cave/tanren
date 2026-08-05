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

// A deterministic INJECTED model-price source (not the vendored 1.3 MB file) so the
// NOTIONAL estimate is computed against known rates. Shaped like LiteLLM upstream
// rows (cost PER TOKEN). `priced-openai`: 2.5/M in, 10/M out, 1.25/M cache-read.
const fixturePriceMap: ModelPriceMap = {
  "priced-openai": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
  },
  "priced-codex": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
  },
};
const fixturePriceSource = new ModelPriceSource(fixturePriceMap);

describe("cost source attribution", () => {
  it("classifies a Codex ChatGPT subscription ref as subscription billing", () => {
    expect(classifyAuthRef("credential/codex/team-prod")).toEqual({
      billingMode: "subscription",
      provider: "openai",
    });
  });

  it("classifies an Anthropic API key ref as per_token billing", () => {
    expect(classifyAuthRef("credential/anthropic/prod")).toEqual({
      billingMode: "per_token",
      provider: "anthropic",
    });
  });

  it("classifies an OpenAI direct-API ref as per_token billing", () => {
    expect(classifyAuthRef("credential/openai-api/prod")).toEqual({
      billingMode: "per_token",
      provider: "openai",
    });
  });

  it("classifies a self-hosted endpoint ref as self_hosted billing", () => {
    expect(classifyAuthRef("credential/self-hosted/local-qwen")).toEqual({
      billingMode: "self_hosted",
      provider: "local-qwen",
    });
  });

  it("BUDGET-SAFETY C1: classifies an unrecognized credential prefix as 'unrecognized' (not silently unknown)", () => {
    const classification = classifyAuthRef("credential/legacy/whatever");
    expect(classification.billingMode).toBe("unrecognized");
    // The ref KIND only (secret name stripped) is surfaced — never the secret value.
    expect(classification).toMatchObject({ refKind: "credential/legacy" });
  });

  it("BUDGET-SAFETY C1: classifies the empty (no-credential) ref as honestly 'absent'", () => {
    expect(classifyAuthRef("").billingMode).toBe("absent");
  });

  // SaaS Tier-B #5: a MANAGED run resolves the platform OpenRouter ref. It must
  // classify exactly like any other OpenRouter credential so the hosting layer's
  // metering captures managed usage as per_token.
  it("classifies the managed platform OpenRouter ref as per_token openrouter billing", () => {
    expect(classifyAuthRef("credential/openrouter/platform/default")).toEqual({
      billingMode: "per_token",
      provider: "openrouter",
    });
  });

  it("REAL SPEND IS A FACT: a managed OpenRouter per_token call with NO captured cost is honest-null (no table)", () => {
    // There is NO list-rate table. A per_token credential with no captured real-spend
    // fact records cost_usd = NULL with cost_basis = 'unknown' — never a guess.
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("unknown");
    expect(source.provider).toBe("openrouter");
    expect(source.realProviderCostUsd).toBeNull();
    expect(computeCostUsd(source, usage({ inputTokens: 1_000_000 }))).toBeNull();
  });

  it("a BYOK per_token provider (openai/anthropic) with no fact is honest-null (real charge is on the upstream invoice)", () => {
    for (const ref of ["credential/openai-api/k", "credential/anthropic/k"]) {
      const source = resolveCostSource({ cli: "codex", authRef: ref, model: "priced-openai", rawUsage: {} });
      expect(source.billingMode).toBe("per_token");
      expect(source.costBasis).toBe("unknown");
      expect(computeCostUsd(source, usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeNull();
    }
  });

  it("captures OpenRouter's REAL usage.cost as provider_response — cost_usd is the real figure (a metered FACT)", () => {
    // The accurate path: a captured OpenRouter `usage.cost` (the REAL deduction). It
    // sets real spend directly and is NEVER an estimate. Notional stays a SEPARATE,
    // model-priced figure that may honestly differ from the real charge.
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      realProviderCostUsd: 0.0731,
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("provider_response");
    expect(source.provider).toBe("openrouter");
    expect(source.realProviderCostUsd).toBe(0.0731);
    // Real spend == the captured figure, regardless of tokens.
    expect(computeCostUsd(source, usage({ inputTokens: 9_999, outputTokens: 9_999 }))).toBe("0.073100");
  });

  it("a real provider_response figure OUTRANKS a ccusage figure on the same call", () => {
    // Both present → the provider's OWN authoritative charge wins (no markup, native
    // tokenizer); the ccusage figure is dropped from real spend.
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      realProviderCostUsd: 0.05,
      ccusageCostUsd: 0.09,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("provider_response");
    expect(source.realProviderCostUsd).toBe(0.05);
    expect(source.ccusageCostUsd).toBeNull();
    expect(computeCostUsd(source, usage({ inputTokens: 1, outputTokens: 1 }))).toBe("0.050000");
  });

  it("ignores a zero/negative provider cost and, with no other fact, is honest-null", () => {
    const zero = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      realProviderCostUsd: 0,
      rawUsage: {},
    });
    expect(zero.costBasis).toBe("unknown");
    const negative = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      realProviderCostUsd: -1,
      rawUsage: {},
    });
    expect(negative.costBasis).toBe("unknown");
  });

  it("resolves a subscription ref to cost_basis 'unknown' (no fake estimate)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: { foo: "bar" },
    });
    expect(source.billingMode).toBe("subscription");
    expect(source.costBasis).toBe("unknown");
  });

  it("resolves a per_token ref with no captured fact to cost_basis 'unknown' (no static table)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/key1",
      model: "priced-openai",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("unknown");
    expect(source.provider).toBe("openai");
  });

  it("resolves a self-hosted ref to cost_basis 'unknown'", () => {
    const source = resolveCostSource({
      cli: "fake",
      authRef: "credential/self-hosted/qwen",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("self_hosted");
    expect(source.costBasis).toBe("unknown");
  });

  it("BUDGET-SAFETY C1: resolves an UNRECOGNIZED ref to 'unattributed' (NOT a silent $0 self_hosted)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "vault/secret/dev/random",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("unattributed");
    expect(source.costBasis).toBe("unattributed");
    expect(source.unattributedRefKind).toBe("vault/secret/dev");
    // Cost is still genuinely NULL — we cannot price it — but it is NOT silent.
    expect(computeCostUsd(source, usage({ inputTokens: 100, outputTokens: 100 }))).toBeNull();
  });

  it("BUDGET-SAFETY C1: an UNRECOGNIZED ref stays 'unattributed' even with a ccusage figure (ccusage prices ONLY per_token)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "vault/secret/dev/random",
      ccusageCostUsd: 0.9,
      rawUsage: {},
    });
    expect(source.billingMode).toBe("unattributed");
    expect(source.costBasis).toBe("unattributed");
    expect(source.ccusageCostUsd).toBeNull();
    expect(source.unattributedRefKind).not.toBeNull();
  });

  it("resolves an empty (no-credential) ref to cost_basis 'unknown', NOT unattributed", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "", rawUsage: {} });
    expect(source.costBasis).toBe("unknown");
    expect(source.billingMode).toBe("self_hosted");
    expect(source.unattributedRefKind).toBeNull();
  });

  it("lets a positive ccusage figure set REAL spend as a FACT (cost_basis ccusage)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "priced-openai",
      ccusageCostUsd: 0.42,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    expect(source.ccusageCostUsd).toBe(0.42);
  });

  it("does NOT price a subscription credential from ccusage — its figure is notional token-value, not real spend", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: 1.5,
      rawUsage: {},
    });
    expect(source.billingMode).toBe("subscription");
    expect(source.costBasis).toBe("unknown");
    expect(source.ccusageCostUsd).toBeNull();
  });

  it("ignores a zero/negative ccusage figure and falls back to honest-null", () => {
    const zero = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0,
      rawUsage: {},
    });
    expect(zero.costBasis).toBe("unknown");
    const negative = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: -3,
      rawUsage: {},
    });
    expect(negative.costBasis).toBe("unknown");
  });
});

describe("cost USD computation — REAL SPEND IS A FACT", () => {
  it("returns the provider_response real figure verbatim (tokens irrelevant)", () => {
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      model: "priced-openai",
      realProviderCostUsd: 0.5,
      rawUsage: {},
    });
    expect(computeCostUsd(source, usage({ inputTokens: 9_999_999 }))).toBe("0.500000");
  });

  it("returns the real ccusage figure for cost_basis 'ccusage' (tokens irrelevant)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "priced-openai",
      ccusageCostUsd: 3.25,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    expect(computeCostUsd(source, usage({ inputTokens: 9_999_999, outputTokens: 9_999_999 }))).toBe("3.250000");
  });

  it("returns null cost for subscription billing (no fake denominator)", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "credential/codex/dev", rawUsage: {} });
    expect(computeCostUsd(source, usage({ inputTokens: 100_000, outputTokens: 100_000 }))).toBeNull();
  });

  it("returns null cost for self-hosted billing", () => {
    const source = resolveCostSource({ cli: "fake", authRef: "credential/self-hosted/qwen", rawUsage: {} });
    expect(computeCostUsd(source, usage({ inputTokens: 100, outputTokens: 100 }))).toBeNull();
  });

  it("returns null cost for a per_token call with no captured fact (no list-rate table)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "priced-openai",
      rawUsage: {},
    });
    expect(computeCostUsd(source, usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeNull();
  });
});

describe("notional (ListCost) computation — computeNotionalUsd from the LiteLLM model price", () => {
  // priced-openai list rate: 2.5/M input, 10/M output. 1M input + 0.5M output = 2.5 + 5 = $7.50.
  const NOTIONAL_TOKENS = usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 });

  it("computes notional from the model price for a subscription call (real spend is NULL there)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      model: "priced-codex",
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    // The figure AND why it is a figure: priced off the model rate, not carried
    // over from a ccusage fact (this call has none).
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: "7.500000",
      reason: "priced",
    });
  });

  it("computes notional from the model price for a per_token call (real spend NULL with no fact)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "priced-openai",
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: "7.500000",
      reason: "priced",
    });
  });

  it("bills cached-input at the cache-read rate and reasoning at the output rate (model price)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "priced-openai",
      rawUsage: {},
    });
    // priced-openai: in 2.5, out 10, cache-read 1.25.
    // 1M cached @1.25 + 1M reasoning @10 = 1.25 + 10 = 11.25
    const tokens = usage({ cachedInputTokens: 1_000_000, reasoningOutputTokens: 1_000_000 });
    const notional = computeNotionalUsd(source, tokens, fixturePriceSource);
    expect(Number(notional.usd)).toBeCloseTo(11.25, 5);
    expect(notional.reason).toBe("priced");
  });

  it("prefers a positive ccusage figure as notional over the model rate (subscription)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      model: "priced-codex",
      ccusageCostUsd: 1.5,
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    // The ccusage figure verbatim, and the reason says the model rate was never
    // consulted — a mutant that fell through to the price table would say "priced".
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: "1.500000",
      reason: "ccusage",
    });
  });

  it("returns null notional for an UNRECOGNIZED ref (unpriced on both axes — no model price, ccusage untrusted)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "vault/secret/dev/random",
      model: "priced-openai",
      ccusageCostUsd: 0.9,
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    // NULL, and the reason names the misconfig — NOT `model_not_listed` (the model
    // IS listed here; the credential is what we refuse to trust).
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: null,
      reason: "unattributed_credential",
    });
  });

  it("returns null notional when the call's MODEL is not in the price source (LOUD-unknown)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      model: "model-not-in-source",
      rawUsage: {},
    });
    // The price source WAS consultable (a populated fixture map → health 'ready'),
    // so the null is a fact about the model, not an outage.
    expect(fixturePriceSource.health()).toBe("ready");
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: null,
      reason: "model_not_listed",
    });
  });

  it("returns null notional when the call carries no model id", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "credential/openai-api/k", rawUsage: {} });
    // A real token-bearing call with no model id is a DEFECT in the caller, and the
    // reason code says so rather than blaming the price source.
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS, fixturePriceSource)).toEqual({
      usd: null,
      reason: "model_id_absent",
    });
  });
});
