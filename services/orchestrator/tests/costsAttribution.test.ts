import { describe, expect, it } from "vitest";
import { classifyAuthRef, computeCostUsd, computeNotionalUsd, resolveCostSource } from "../src/engine/costs/index.js";
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
  // metering captures managed usage as per_token / provider_pricing.
  it("classifies the managed platform OpenRouter ref as per_token openrouter billing", () => {
    expect(classifyAuthRef("credential/openrouter/platform/default")).toEqual({
      billingMode: "per_token",
      provider: "openrouter",
    });
  });

  it("prices a managed platform OpenRouter run via provider_pricing but FLAGS it estimateOnly (no real cost captured)", () => {
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("provider_pricing");
    expect(source.provider).toBe("openrouter");
    expect(source.rate?.inputCostPerMillion).toBeGreaterThan(0);
    // LOUD ESTIMATE: OpenRouter's authoritative `usage.cost` was NOT captured for
    // this call, so the static-table figure is an estimate, not the real charge —
    // it must be flagged so an operator never mistakes it for real spend.
    expect(source.estimateOnly).toBe(true);
    expect(source.realProviderCostUsd).toBeNull();
  });

  it("does NOT flag estimateOnly for a per_token provider with no authoritative per-call charge (openai/anthropic)", () => {
    // openai/anthropic expose no per-call provider charge to capture, so the static
    // table is the BEST available basis here — not a stand-in for a reachable real
    // figure. Flagging it would be a false alarm.
    for (const ref of ["credential/openai-api/k", "credential/anthropic/k"]) {
      const source = resolveCostSource({ cli: "codex", authRef: ref, rawUsage: {} });
      expect(source.costBasis).toBe("provider_pricing");
      expect(source.estimateOnly).toBe(false);
    }
  });

  it("captures OpenRouter's REAL usage.cost as provider_response — cost_usd is the real figure, outranking the static table", () => {
    // The accurate path: a captured OpenRouter `usage.cost` (the REAL deduction).
    // It OUTRANKS the static rate table, sets real spend directly, and is NEVER an
    // estimate. The notional list value stays the rate-table computation (it may
    // honestly differ from the real charge).
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      realProviderCostUsd: 0.0731,
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("provider_response");
    expect(source.provider).toBe("openrouter");
    expect(source.realProviderCostUsd).toBe(0.0731);
    expect(source.estimateOnly).toBe(false);
    // Real spend == the captured figure, regardless of tokens.
    expect(computeCostUsd(source, usage({ inputTokens: 9_999, outputTokens: 9_999 }))).toBe("0.073100");
    // Notional stays the list-rate value (rate ride-through), independent of real.
    expect(source.notionalRate?.inputCostPerMillion).toBeGreaterThan(0);
  });

  it("a real provider_response figure OUTRANKS a ccusage figure on the same call", () => {
    // Both present → the provider's OWN authoritative charge wins (no markup, native
    // tokenizer); the ccusage figure is dropped from real spend.
    const source = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      realProviderCostUsd: 0.05,
      ccusageCostUsd: 0.09,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("provider_response");
    expect(source.realProviderCostUsd).toBe(0.05);
    expect(source.ccusageCostUsd).toBeNull();
    expect(computeCostUsd(source, usage({ inputTokens: 1, outputTokens: 1 }))).toBe("0.050000");
  });

  it("ignores a zero/negative provider cost and falls back to the next basis (flagged estimate for openrouter)", () => {
    const zero = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      realProviderCostUsd: 0,
      rawUsage: {},
    });
    expect(zero.costBasis).toBe("provider_pricing");
    expect(zero.estimateOnly).toBe(true);
    const negative = resolveCostSource({
      cli: "aider",
      authRef: "credential/openrouter/platform/default",
      realProviderCostUsd: -1,
      rawUsage: {},
    });
    expect(negative.costBasis).toBe("provider_pricing");
  });

  it("resolves a subscription ref to cost_basis 'unknown' (no fake estimate)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: { foo: "bar" },
    });
    expect(source.billingMode).toBe("subscription");
    expect(source.costBasis).toBe("unknown");
    expect(source.rate).toBeNull();
  });

  it("resolves a per_token ref to provider_pricing with the openai rate table", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/key1",
      rawUsage: {},
    });
    expect(source.billingMode).toBe("per_token");
    expect(source.costBasis).toBe("provider_pricing");
    expect(source.provider).toBe("openai");
    expect(source.rate?.inputCostPerMillion).toBeGreaterThan(0);
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
    // The old behavior silently relabeled this to billingMode='self_hosted',
    // costBasis='unknown' → a $0 budget contribution. It must now be flagged.
    expect(source.billingMode).toBe("unattributed");
    expect(source.costBasis).toBe("unattributed");
    expect(source.unattributedRefKind).toBe("vault/secret/dev");
    // Cost is still genuinely NULL — we cannot price it — but it is NOT silent.
    expect(computeCostUsd(source, usage({ inputTokens: 100, outputTokens: 100 }))).toBeNull();
  });

  it("BUDGET-SAFETY C1: an UNRECOGNIZED ref stays 'unattributed' even with a ccusage figure (ccusage prices ONLY per_token)", () => {
    // ccusage's dollar figure is only a trustworthy REAL spend signal for a
    // recognized per-token (real-API) credential. On an unrecognized ref we cannot
    // know the billing model, so a ccusage figure does NOT rescue it into a priced
    // row — it stays the loud, fail-closed `unattributed` misconfig.
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

  it("lets a positive ccusage figure win over the static provider table", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0.42,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    expect(source.ccusageCostUsd).toBe(0.42);
    expect(source.rate).toBeNull();
  });

  it("does NOT price a subscription credential from ccusage — its figure is notional token-value, not real spend", () => {
    // A flat-fee subscription's within-window usage has $0 real marginal cost.
    // ccusage computes the NOTIONAL list-price value of those tokens; that must
    // never become a priced row (it would phantom-trip the dollar budget gate).
    // The honest result is an `unknown`/NULL subscription row.
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

  it("ignores a zero/negative ccusage figure and falls back to the normal basis", () => {
    const zero = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 0,
      rawUsage: {},
    });
    expect(zero.costBasis).toBe("provider_pricing");
    const negative = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: -3,
      rawUsage: {},
    });
    expect(negative.costBasis).toBe("unknown");
  });
});

describe("cost USD computation", () => {
  it("computes provider_pricing cost from disjoint buckets", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      rawUsage: {},
    });
    const usd = computeCostUsd(source, usage({ inputTokens: 1_000_000, outputTokens: 500_000 }));
    // openai rate table: 2.5/in, 10/out -> 2.5 + 5 = 7.5
    expect(Number(usd)).toBeCloseTo(7.5, 5);
  });

  it("bills cached-input at the cache rate and reasoning at the output rate", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      rawUsage: {},
    });
    // openai: in 2.5, out 10, cached 1.25.
    // 1M cached @1.25 + 1M reasoning @10 = 1.25 + 10 = 11.25
    const usd = computeCostUsd(source, usage({ cachedInputTokens: 1_000_000, reasoningOutputTokens: 1_000_000 }));
    expect(Number(usd)).toBeCloseTo(11.25, 5);
  });

  it("returns null cost for subscription billing (no fake denominator)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      rawUsage: {},
    });
    expect(computeCostUsd(source, usage({ inputTokens: 100_000, outputTokens: 100_000 }))).toBeNull();
  });

  it("returns null cost for self-hosted billing", () => {
    const source = resolveCostSource({
      cli: "fake",
      authRef: "credential/self-hosted/qwen",
      rawUsage: {},
    });
    expect(computeCostUsd(source, usage({ inputTokens: 100, outputTokens: 100 }))).toBeNull();
  });

  it("returns the real ccusage figure (not a token-priced estimate) for cost_basis 'ccusage'", () => {
    // ccusage prices only a real-API (per_token) credential — that is the call whose
    // ccusage figure is genuine billed spend.
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/openai-api/k",
      ccusageCostUsd: 3.25,
      rawUsage: {},
    });
    expect(source.costBasis).toBe("ccusage");
    // Tokens are irrelevant to the dollar figure here — ccusage already priced it.
    expect(computeCostUsd(source, usage({ inputTokens: 9_999_999, outputTokens: 9_999_999 }))).toBe("3.250000");
  });
});

describe("notional (ListCost) computation — computeNotionalUsd", () => {
  // openai list rate: 2.5/M input, 10/M output. 1M input + 0.5M output = 2.5 + 5 = $7.50.
  const NOTIONAL_TOKENS = usage({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 });

  it("ALWAYS computes notional list value for a subscription call (real spend is NULL there)", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "credential/codex/dev", rawUsage: {} });
    // REAL spend is NULL (subscription window has no marginal cost)...
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    // ...but NOTIONAL is the openai list value of the same tokens.
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBe("7.500000");
  });

  it("notional == real for a per_token provider_pricing call", () => {
    const source = resolveCostSource({ cli: "codex", authRef: "credential/openai-api/k", rawUsage: {} });
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBe(computeCostUsd(source, NOTIONAL_TOKENS));
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBe("7.500000");
  });

  it("prefers a positive ccusage figure as notional over the static rate (subscription)", () => {
    // A subscription cred WITH ccusage: real spend still NULL, but notional uses the
    // (more-accurate) ccusage value, not the $7.50 static-rate figure.
    const source = resolveCostSource({
      cli: "codex",
      authRef: "credential/codex/dev",
      ccusageCostUsd: 1.5,
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBe("1.500000");
  });

  it("returns null notional for an UNRECOGNIZED ref (unpriced on both axes — no list value, ccusage untrusted)", () => {
    const source = resolveCostSource({
      cli: "codex",
      authRef: "vault/secret/dev/random",
      ccusageCostUsd: 0.9,
      rawUsage: {},
    });
    expect(computeCostUsd(source, NOTIONAL_TOKENS)).toBeNull();
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBeNull();
  });

  it("returns null notional for a self-hosted ref whose provider has no list rate", () => {
    // `credential/self-hosted/qwen` → provider 'qwen', which has NO list rate, so even
    // notional is honestly null (no fake estimate).
    const source = resolveCostSource({ cli: "fake", authRef: "credential/self-hosted/qwen", rawUsage: {} });
    expect(computeNotionalUsd(source, NOTIONAL_TOKENS)).toBeNull();
  });
});
