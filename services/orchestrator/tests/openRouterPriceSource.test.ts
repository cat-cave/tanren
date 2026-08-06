// OpenRouter LIVE list pricing — the notional axis's authoritative source for a
// marketplace route.
//
// The fixtures below are VERBATIM entries from a real
// `GET https://openrouter.ai/api/v1/models` response captured 2026-08-04 (338
// models). They are shape evidence, not invention: the tiered `overrides` block and
// the `"-1"` auto-router sentinel are both real and both change the arithmetic.
import { describe, expect, it } from "vitest";

import { CompositeModelPriceSource, type ModelPriceLookup } from "../src/engine/costs/pricing/compositePriceSource.js";
import { costPriceSource, warmCostPriceSource } from "../src/engine/costs/pricing/costPriceSource.js";
import { ModelPriceSource, PRICE_TIERS_KEY } from "../src/engine/costs/pricing/modelPriceSource.js";
import {
  fetchOpenRouterPriceMap,
  normalizeOpenRouterModels,
  OPENROUTER_MODELS_URL,
} from "../src/engine/costs/pricing/openRouterPriceSource.js";

// VERBATIM from the live catalogue. This is the model this deployment's org config
// pins (`defaultLlm.model = "openai/gpt-5.6-luna"`) — and the model LiteLLM's table
// does not contain under any key.
const LUNA = {
  id: "openai/gpt-5.6-luna",
  pricing: {
    prompt: "0.0000001",
    completion: "0.0000006",
    web_search: "0.005",
    input_cache_read: "0.00000001",
    input_cache_write: "0.000000125",
    overrides: [
      {
        min_prompt_tokens: 272000,
        prompt: "0.0000002",
        completion: "0.0000009",
        input_cache_read: "0.00000002",
        input_cache_write: "0.00000025",
      },
    ],
  },
};

// VERBATIM. OpenRouter prices its auto-routers at "-1" — a sentinel for "depends on
// the model the router picks", i.e. genuinely unknowable in advance.
const AUTO_ROUTER = { id: "openrouter/auto-beta", pricing: { prompt: "-1", completion: "-1" } };

const SIMPLE = { id: "qwen/qwen3.8-max", pricing: { prompt: "0.000002", completion: "0.000006" } };

const BODY = { data: [LUNA, AUTO_ROUTER, SIMPLE] };

describe("normalizeOpenRouterModels", () => {
  it("prices the model LiteLLM cannot: the marketplace id tanren actually sends", () => {
    const price = new ModelPriceSource(normalizeOpenRouterModels(BODY)).lookup("openai/gpt-5.6-luna");
    expect(price).not.toBeNull();
    // Per-token in, per-million out — the unit the notional arithmetic bills in.
    expect(price?.input?.costPerToken).toBe(0.0000001);
    expect(price?.input?.costPerMillion).toBeCloseTo(0.1, 10);
    expect(price?.output?.costPerMillion).toBeCloseTo(0.6, 10);
    expect(price?.cacheRead?.costPerMillion).toBeCloseTo(0.01, 10);
    expect(price?.cacheCreation?.costPerMillion).toBeCloseTo(0.125, 10);
  });

  it("stamps the openrouter provider so a provider-asserted lookup matches", () => {
    const price = new ModelPriceSource(normalizeOpenRouterModels(BODY)).lookup("openai/gpt-5.6-luna", "openrouter");
    expect(price?.provider).toBe("openrouter");
  });

  it("REFUSES the -1 auto-router sentinel instead of inventing a negative rate", () => {
    // The critical negative control. `-1` is not a price. Recording it would make a
    // call APPEAR to earn money, and would corrupt any sum over the column.
    const source = new ModelPriceSource(normalizeOpenRouterModels(BODY));
    expect(source.lookup("openrouter/auto-beta")).toBeNull();
    expect(source.models()).not.toContain("openrouter/auto-beta");
  });

  it("carries long-context tiers, ascending, with only the axes upstream restates", () => {
    const map = normalizeOpenRouterModels(BODY);
    const tiers = (map["openai/gpt-5.6-luna"] as Record<string, unknown>)[PRICE_TIERS_KEY];
    expect(tiers).toEqual([
      {
        minPromptTokens: 272000,
        inputCostPerToken: 0.0000002,
        outputCostPerToken: 0.0000009,
        cacheReadCostPerToken: 0.00000002,
        cacheCreationCostPerToken: 0.00000025,
      },
    ]);
  });

  it("leaves a model with no overrides tier-free (flat rates always apply)", () => {
    const map = normalizeOpenRouterModels(BODY);
    expect((map["qwen/qwen3.8-max"] as Record<string, unknown>)[PRICE_TIERS_KEY]).toBeUndefined();
    expect(new ModelPriceSource(map).lookup("qwen/qwen3.8-max")?.tiers).toEqual([]);
  });

  it("THROWS on a malformed body rather than installing an empty table", () => {
    // A silently-empty table would null every model at once and look exactly like
    // "nothing is priced" — the failure mode this whole change exists to remove.
    expect(() => normalizeOpenRouterModels(null)).toThrow(/not a JSON object/u);
    expect(() => normalizeOpenRouterModels({})).toThrow(/no `data` array/u);
    expect(() => normalizeOpenRouterModels({ data: {} })).toThrow(/no `data` array/u);
  });

  it("skips junk entries without discarding the good ones", () => {
    const map = normalizeOpenRouterModels({ data: [null, { id: "" }, { id: "x" }, SIMPLE, { pricing: {} }] });
    expect(Object.keys(map)).toEqual(["qwen/qwen3.8-max"]);
  });
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("fetchOpenRouterPriceMap", () => {
  it("fetches the public catalogue with NO credential attached", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    await fetchOpenRouterPriceMap((async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return okResponse(BODY);
    }) as unknown as typeof fetch);
    expect(seenUrl).toBe(OPENROUTER_MODELS_URL);
    // Secret hygiene, asserted rather than assumed: pricing is public data and this
    // path must never carry the tenant's OpenRouter key.
    const headers = JSON.stringify(seenInit?.headers ?? {}).toLowerCase();
    expect(headers).not.toContain("authorization");
    expect(headers).not.toContain("bearer");
  });

  it("throws on a non-2xx so the prior table is kept", async () => {
    await expect(
      fetchOpenRouterPriceMap((async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch),
    ).rejects.toThrow(/status 503/u);
  });

  it("throws on a 200 that yields no priceable models (upstream schema drift)", async () => {
    await expect(
      fetchOpenRouterPriceMap((async () => okResponse({ data: [AUTO_ROUTER] })) as unknown as typeof fetch),
    ).rejects.toThrow(/no priceable models/u);
  });
});

describe("CompositeModelPriceSource", () => {
  // Built lazily, NOT at module scope. A module-scope call to the function under
  // test makes a mutation inside it throw during test COLLECTION, which fails the
  // file without running a single test — the suite goes red, but the mutant cannot
  // be attributed to a killing test and is reported as survived. Keeping the call
  // inside the test bodies makes detection legible to mutation testing.
  const openRouter = () => new ModelPriceSource(normalizeOpenRouterModels(BODY));
  // A stand-in for the LiteLLM leg, keyed in ITS id space.
  const liteLlm = new ModelPriceSource({
    "gpt-5.6-luna": { litellm_provider: "openai", input_cost_per_token: 0.000005, output_cost_per_token: 0.00001 },
  });

  it("prefers the marketplace's own quote when it sells the model", () => {
    const both = new ModelPriceSource(normalizeOpenRouterModels({ data: [SIMPLE] }));
    const rival = new ModelPriceSource({
      "qwen/qwen3.8-max": { litellm_provider: "openrouter", input_cost_per_token: 0.999 },
    });
    const price = new CompositeModelPriceSource(both, rival).lookup("qwen/qwen3.8-max");
    // The seller's price, not the mirror's.
    expect(price?.input?.costPerToken).toBe(0.000002);
  });

  it("falls through to LiteLLM for a direct-vendor id OpenRouter does not sell", () => {
    const price = new CompositeModelPriceSource(openRouter(), liteLlm).lookup("gpt-5.6-luna", "openai");
    expect(price?.input?.costPerToken).toBe(0.000005);
  });

  it("does NOT apply the caller's provider assertion to the OpenRouter leg", () => {
    // Regression guard: every OpenRouter row is stamped provider "openrouter", so
    // passing through a caller's "openai" would reject the very row we want and
    // silently fall through to a source that does not have it either.
    const price = new CompositeModelPriceSource(openRouter(), liteLlm).lookup("openai/gpt-5.6-luna", "openai");
    expect(price?.provider).toBe("openrouter");
  });

  it("is ready when EITHER leg is, and unavailable only when neither is", () => {
    const empty = new ModelPriceSource({});
    expect(new CompositeModelPriceSource(openRouter(), empty).health()).toBe("ready");
    expect(new CompositeModelPriceSource(empty, liteLlm).health()).toBe("ready");
    expect(new CompositeModelPriceSource(empty, empty).health()).toBe("unavailable");
  });

  it("reports the OpenRouter leg's health for an OpenRouter route, not the union", () => {
    // A ready LiteLLM leg must not be allowed to claim the marketplace is reachable —
    // that is what mislabels an outage as `model_not_listed`.
    //
    // REGRESSION: this used to be asserted against a separate `openRouterHealth()`
    // accessor that NOTHING called. `computeNotionalUsd` asked the bare `health()`,
    // whose OR is `ready` whenever the vendored-seeded LiteLLM leg is — which is
    // always. So the distinction this whole reason-code split exists for was
    // structurally unreachable in production. The route hint is now part of the
    // `ModelPriceLookup` contract, and the notional call site passes the same one it
    // passes to `lookup`.
    const composite = new CompositeModelPriceSource(new ModelPriceSource({}), liteLlm);
    expect(composite.health("openrouter")).toBe("unavailable");
    // A direct-vendor route is still answerable by the LiteLLM leg.
    expect(composite.health("anthropic")).toBe("ready");
    expect(composite.health()).toBe("ready");
  });

  it("satisfies the ModelPriceLookup contract the cost path is typed on", () => {
    const lookup: ModelPriceLookup = new CompositeModelPriceSource(openRouter(), liteLlm);
    expect(typeof lookup.lookup).toBe("function");
    expect(typeof lookup.health).toBe("function");
  });
});

describe("costPriceSource — the production wiring", () => {
  it("memoizes one composite so the TTL cache is shared across every cost call", () => {
    // A per-call source would re-fetch (or, worse, sit permanently cold) on every
    // recorded row.
    expect(costPriceSource()).toBe(costPriceSource());
  });

  it("composes the OpenRouter leg in front of the LiteLLM leg", () => {
    // Under vitest both legs are frozen and network-free: OpenRouter has no seed
    // (so its leg is unavailable) while LiteLLM has the vendored seed (so it is
    // ready). That asymmetry is exactly what distinguishes the two legs here — and
    // it is the PRODUCTION cold-start shape, not a test artifact, which is why an
    // OpenRouter route must read `unavailable` here.
    const source = costPriceSource();
    expect(source.health("openrouter")).toBe("unavailable");
    expect(source.health()).toBe("ready");
  });

  it("still prices a direct-vendor model through the fallback leg while OpenRouter is cold", () => {
    // Non-vacuous: proves the composite is wired to a REAL LiteLLM leg, not an
    // empty one, and that a cold OpenRouter leg does not block the fallthrough.
    expect(costPriceSource().lookup("gpt-4o-mini")).not.toBeNull();
  });

  it("warm() never throws and never blocks (no wall-clock deadline exists)", () => {
    // Doctrine: `no-arbitrary-timeouts` forbids racing this against a timer, so the
    // warm must be a plain fire-and-forget trigger. Frozen under tests → a no-op.
    expect(() => warmCostPriceSource()).not.toThrow();
    expect(warmCostPriceSource()).toBeUndefined();
  });
});

// ── the guards that keep a non-price from becoming a price ────────────────────
// Mutation testing showed every one of these branches surviving: the happy-path
// tests above never reach them, so the module's whole safety story — "a malformed,
// missing or negative rate is NOT a rate" — was unverified. Each case below is a
// value OpenRouter's schema permits (or would permit under drift) that must never
// be coerced into a number.
describe("parseRate guards — a non-price never becomes a price", () => {
  const rejected: ReadonlyArray<[string, unknown]> = [
    ["a number (OpenRouter sends strings; a number means schema drift)", 0.000001],
    ["null", null],
    ["undefined / key absent", undefined],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["non-numeric text", "free"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["a negative rate", "-0.5"],
    ["the -1 auto-router sentinel", "-1"],
    ["an object", { amount: "1" }],
  ];

  for (const [name, prompt] of rejected) {
    it(`rejects ${name} on the prompt axis`, () => {
      const map = normalizeOpenRouterModels({ data: [{ id: "m/x", pricing: { prompt, completion: "0.000002" } }] });
      // The model is still priceable via completion, but the bad prompt axis is
      // ABSENT rather than zero/NaN/negative.
      expect(new ModelPriceSource(map).lookup("m/x")?.input).toBeNull();
    });
  }

  it("accepts a legitimate zero rate (a free model is priced at 0, not unpriced)", () => {
    // The boundary that must NOT be swept up by the negative guard.
    const map = normalizeOpenRouterModels({ data: [{ id: "m/free", pricing: { prompt: "0", completion: "0" } }] });
    expect(new ModelPriceSource(map).lookup("m/free")?.input?.costPerToken).toBe(0);
  });

  it("drops a model whose BOTH axes are unusable, keeping it out of the table", () => {
    const map = normalizeOpenRouterModels({ data: [{ id: "m/bad", pricing: { prompt: "-1", completion: "junk" } }] });
    expect(map["m/bad"]).toBeUndefined();
  });

  it("skips an entry with an empty id or a non-object pricing block", () => {
    const map = normalizeOpenRouterModels({
      data: [
        { id: "", pricing: { prompt: "0.1", completion: "0.2" } },
        { id: "m/no-pricing", pricing: "cheap" },
        { id: "m/null-pricing", pricing: null },
        { id: "m/ok", pricing: { prompt: "0.000001", completion: "0.000002" } },
      ],
    });
    expect(Object.keys(map)).toEqual(["m/ok"]);
  });
});

function tiersOf(overrides: unknown) {
  const map = normalizeOpenRouterModels({
    data: [{ id: "m/t", pricing: { prompt: "0.000001", completion: "0.000002", overrides } }],
  });
  return new ModelPriceSource(map).lookup("m/t")?.tiers;
}

describe("parseTier guards — a malformed tier degrades to flat pricing, never un-prices", () => {
  const dropped: ReadonlyArray<[string, unknown]> = [
    ["a non-object tier", "272000"],
    ["a null tier", null],
    ["a tier with no floor", { prompt: "0.000002" }],
    ["a tier whose floor is a string", { min_prompt_tokens: "272000", prompt: "0.000002" }],
    ["a tier whose floor is negative", { min_prompt_tokens: -1, prompt: "0.000002" }],
    ["a tier whose floor is not finite", { min_prompt_tokens: Number.POSITIVE_INFINITY, prompt: "0.000002" }],
    ["a tier that restates NO usable rate", { min_prompt_tokens: 272000, prompt: "-1" }],
  ];

  for (const [name, tier] of dropped) {
    it(`drops ${name}`, () => {
      expect(tiersOf([tier])).toEqual([]);
    });
  }

  it("keeps a valid tier alongside dropped ones, rather than discarding the batch", () => {
    const tiers = tiersOf([null, { min_prompt_tokens: 100, prompt: "0.000009" }, "junk"]);
    expect(tiers).toEqual([{ minPromptTokens: 100, inputCostPerToken: 0.000009 }]);
  });

  it("sorts tiers ASCENDING by floor regardless of the order upstream sends them", () => {
    // Tier selection scans for the LAST match, so a descending upstream order would
    // silently select the cheapest tier for the largest prompt.
    const tiers = tiersOf([
      { min_prompt_tokens: 900_000, prompt: "0.000009" },
      { min_prompt_tokens: 100, prompt: "0.000001" },
      { min_prompt_tokens: 5_000, prompt: "0.000005" },
    ]);
    expect(tiers?.map((tier) => tier.minPromptTokens)).toEqual([100, 5_000, 900_000]);
  });

  it("carries only the axes a tier actually restates", () => {
    // Overrides commonly restate prompt+completion but not the cache axes; inventing
    // the missing ones would silently re-rate cached tokens.
    expect(tiersOf([{ min_prompt_tokens: 10, prompt: "0.000004" }])).toEqual([
      { minPromptTokens: 10, inputCostPerToken: 0.000004 },
    ]);
  });

  it("ignores a non-array overrides value", () => {
    expect(tiersOf({ min_prompt_tokens: 10, prompt: "0.000004" })).toEqual([]);
  });
});
