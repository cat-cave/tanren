import { describe, expect, it } from "vitest";

import {
  ModelPriceSource,
  defaultModelPriceSource,
  type ModelPriceMap,
} from "../src/engine/costs/pricing/modelPriceSource.js";

// A tiny INJECTED fixture map (not the 1.3 MB vendored file): a couple of priced
// models, the non-model `sample_spec` doc key, our `_tanren_source` manifest key,
// and an un-priced entry. Shaped like the LiteLLM upstream rows (cost PER TOKEN).
const fixtureMap: ModelPriceMap = {
  _tanren_source: { source_url: "https://example.test", fetched_at: "2026-06-04T00:00:00Z" },
  sample_spec: {
    litellm_provider: "one of https://docs.litellm.ai/docs/providers",
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
  "fixture-chat-model": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
    input_cost_per_token_batches: 1.25e-6,
    output_cost_per_token_batches: 5e-6,
  },
  "fixture-anthropic-model": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  // An entry with NO input/output token cost (e.g. a config-only row) — not a
  // priceable model, must resolve to null (LOUD-unknown), never a guessed rate.
  "fixture-unpriced-entry": {
    litellm_provider: "openai",
    mode: "moderation",
  },
};

describe("ModelPriceSource — maintained per-model rate lookup", () => {
  const source = new ModelPriceSource(fixtureMap);

  it("resolves a known model to the expected typed rate shape (per-token + per-million)", () => {
    const price = source.lookup("fixture-chat-model");
    expect(price).not.toBeNull();
    expect(price?.model).toBe("fixture-chat-model");
    expect(price?.provider).toBe("openai");
    expect(price?.mode).toBe("chat");
    expect(price?.input).toEqual({ costPerToken: 2.5e-6, costPerMillion: 2.5 });
    expect(price?.output).toEqual({ costPerToken: 1e-5, costPerMillion: 10 });
  });

  it("returns NULL (loud) for a model not in the source — never a fallback guess", () => {
    expect(source.lookup("model-that-does-not-exist")).toBeNull();
    expect(source.lookup("")).toBeNull();
  });

  it("skips the non-model `sample_spec` documentation key", () => {
    expect(source.lookup("sample_spec")).toBeNull();
    expect(source.models()).not.toContain("sample_spec");
  });

  it("skips the `_tanren_source` manifest header key (leading underscore = metadata)", () => {
    expect(source.lookup("_tanren_source")).toBeNull();
    expect(source.models()).not.toContain("_tanren_source");
  });

  it("parses cache-read + batch fields when present", () => {
    const price = source.lookup("fixture-chat-model");
    expect(price?.cacheRead).toEqual({ costPerToken: 1.25e-6, costPerMillion: 1.25 });
    expect(price?.batchInput).toEqual({ costPerToken: 1.25e-6, costPerMillion: 1.25 });
    expect(price?.batchOutput).toEqual({ costPerToken: 5e-6, costPerMillion: 5 });
    // No cache-creation axis on this fixture → null (not a fabricated 0-rate).
    expect(price?.cacheRead).not.toBeNull();
    expect(price?.cacheCreation).toBeNull();
    expect(price?.batchInput).not.toBeNull();
  });

  it("parses cache-creation (cache-WRITE) when present", () => {
    const price = source.lookup("fixture-anthropic-model");
    expect(price?.cacheCreation).toEqual({ costPerToken: 3.75e-6, costPerMillion: 3.75 });
    expect(price?.cacheRead).toEqual({ costPerToken: 3e-7, costPerMillion: 0.3 });
    // No batch fields on this fixture → null axes.
    expect(price?.batchInput).toBeNull();
    expect(price?.batchOutput).toBeNull();
  });

  it("returns NULL for an entry with no input/output token cost (un-priceable row)", () => {
    expect(source.lookup("fixture-unpriced-entry")).toBeNull();
  });

  it("treats a provider mismatch as not-found rather than a wrong-provider rate", () => {
    expect(source.lookup("fixture-chat-model", "openai")).not.toBeNull();
    expect(source.lookup("fixture-chat-model", "anthropic")).toBeNull();
  });

  it("`models()` lists only priceable models from the injected map", () => {
    expect(source.models().toSorted()).toEqual(["fixture-anthropic-model", "fixture-chat-model"]);
  });
});

describe("ModelPriceSource — vendored snapshot (the real maintained source)", () => {
  // Exercises the production default over the committed LiteLLM snapshot, proving
  // the runtime `readFileSync` load + parse works end-to-end (not just fixtures).
  const source = defaultModelPriceSource();

  it("resolves a well-known model from the vendored LiteLLM data with a positive rate", () => {
    const price = source.lookup("gpt-4o");
    expect(price).not.toBeNull();
    expect(price?.provider).toBe("openai");
    expect(price?.input?.costPerToken).toBeGreaterThan(0);
    expect(price?.output?.costPerToken).toBeGreaterThan(0);
  });

  it("returns NULL (loud) for a model absent from the maintained source", () => {
    expect(source.lookup("totally-made-up-model-xyz-123")).toBeNull();
  });

  it("never resolves the upstream `sample_spec` doc key as a model", () => {
    expect(source.lookup("sample_spec")).toBeNull();
  });
});
