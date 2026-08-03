import { describe, expect, it } from "vitest";
import {
  queryGenerationCost,
  realProviderCostFrom,
  type OpenRouterHttpClient,
  type OpenRouterHttpRequest,
  type OpenRouterHttpResponse,
} from "../src/engine/costs/openRouterCost.js";

// A fake OpenRouter transport: records the request it received and returns a
// canned response. No live key, no network.
class FakeOpenRouterHttp implements OpenRouterHttpClient {
  lastRequest: OpenRouterHttpRequest | null = null;
  constructor(private readonly response: OpenRouterHttpResponse) {}
  async request(input: OpenRouterHttpRequest): Promise<OpenRouterHttpResponse> {
    this.lastRequest = input;
    return this.response;
  }
}

describe("openRouterCost — authoritative per-call charge query", () => {
  it("extracts OpenRouter's REAL total_cost (the deduction from the key's account) from the generation row", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: { data: { id: "gen-1", total_cost: 0.0421 } } });
    const cost = await queryGenerationCost(http, { generationId: "gen-1", token: "sk-or-test" });
    expect(cost).toEqual({
      generationId: "gen-1",
      totalCostUsd: 0.0421,
      upstreamBilled: false,
      upstreamInferenceCostUsd: null,
    });
    // The query hits the documented /generation?id= endpoint with the key as bearer.
    expect(http.lastRequest?.path).toBe("/generation?id=gen-1");
    expect(http.lastRequest?.token).toBe("sk-or-test");
    // An OpenRouter-billed figure IS the authoritative real spend.
    expect(realProviderCostFrom(cost)).toBe(0.0421);
  });

  it("OPENROUTER-BYOK: a positive upstream_inference_cost means total_cost is only a routing fee — flagged and NOT recorded as real spend", async () => {
    // When the tenant attached their own UPSTREAM provider keys inside OpenRouter,
    // OpenRouter charges a routing fee and the real inference cost lands on the
    // upstream provider's bill. Recording total_cost as real spend would UNDERCOUNT.
    // This is read from OpenRouter's OWN report — NOT from a caller-declared flag,
    // which previously conflated "the tenant's credential" with "an upstream biller".
    const http = new FakeOpenRouterHttp({
      status: 200,
      body: { data: { id: "gen-byok", total_cost: 0.01, cost_details: { upstream_inference_cost: 0.42 } } },
    });
    const cost = await queryGenerationCost(http, { generationId: "gen-byok", token: "sk-or-tenant" });
    expect(cost).toMatchObject({ totalCostUsd: 0.01, upstreamBilled: true, upstreamInferenceCostUsd: 0.42 });
    // The authoritative real-spend figure is deliberately null: the figure we have
    // is provably not the whole charge.
    expect(realProviderCostFrom(cost)).toBeNull();
  });

  it("a tenant's OWN OpenRouter key is NOT upstream-billed — its total_cost IS the real deduction", async () => {
    // The regression this rewrite fixes: a tenant-supplied (tanren-\"BYOK\") OpenRouter
    // key is still billed BY OPENROUTER, so its total_cost is authoritative. The old
    // caller-declared `billingModel: 'byok'` discarded exactly this figure.
    const http = new FakeOpenRouterHttp({
      status: 200,
      body: { data: { id: "gen-tenant", total_cost: 0.0011782784, cost_details: { upstream_inference_cost: 0 } } },
    });
    const cost = await queryGenerationCost(http, { generationId: "gen-tenant", token: "sk-or-tenant" });
    expect(cost?.upstreamBilled).toBe(false);
    expect(realProviderCostFrom(cost)).toBe(0.0011782784);
  });

  it("treats a null/absent cost_details.upstream_inference_cost as OpenRouter-billed (the documented non-BYOK shape)", async () => {
    for (const details of [undefined, {}, { upstream_inference_cost: null }, { upstream_inference_cost: 0 }]) {
      const http = new FakeOpenRouterHttp({
        status: 200,
        body: { data: { id: "g", total_cost: 0.02, ...(details === undefined ? {} : { cost_details: details }) } },
      });
      const cost = await queryGenerationCost(http, { generationId: "g", token: "t" });
      expect(cost?.upstreamBilled).toBe(false);
      expect(realProviderCostFrom(cost)).toBe(0.02);
    }
  });

  it("returns null for an absent/non-positive total_cost (honest no-capture, never a fabricated $0)", async () => {
    for (const body of [{ data: { id: "g" } }, { data: { id: "g", total_cost: 0 } }, { data: { total_cost: -1 } }]) {
      const http = new FakeOpenRouterHttp({ status: 200, body });
      const cost = await queryGenerationCost(http, { generationId: "g", token: "t" });
      expect(cost).toBeNull();
      expect(realProviderCostFrom(cost)).toBeNull();
    }
  });

  it("also reads a top-level (unwrapped) cost field and the `cost` alias", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: { id: "g2", cost: 0.005 } });
    const cost = await queryGenerationCost(http, { generationId: "g2", token: "t" });
    expect(cost?.totalCostUsd).toBe(0.005);
  });

  it("throws LOUDLY on a non-200 (transport/auth failure is never a silent miss)", async () => {
    const http = new FakeOpenRouterHttp({ status: 404, body: {} });
    await expect(queryGenerationCost(http, { generationId: "missing", token: "t" })).rejects.toThrow(/status 404/u);
  });

  it("requires a non-empty generation id", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: {} });
    await expect(queryGenerationCost(http, { generationId: "", token: "t" })).rejects.toThrow(
      /generationId is required/u,
    );
  });
});

describe("upstream_inference_cost is read from BOTH placements", () => {
  // OpenRouter reports this under `cost_details` on the generation record, but also
  // surfaces it at the TOP LEVEL of the row on some responses. Checking only the
  // nested one lets an upstream-BYOK generation look fully billed, so `total_cost`
  // — which is then only a routing fee — would be recorded as the real deduction.
  // That UNDER-counts real spend, the one direction this module must never fail in.
  it("detects a TOP-LEVEL upstream_inference_cost, not only the nested one", async () => {
    const http = new FakeOpenRouterHttp({
      status: 200,
      body: { data: { id: "gen-top", total_cost: 0.01, upstream_inference_cost: 0.42 } },
    });
    const cost = await queryGenerationCost(http, { generationId: "gen-top", token: "sk-or-tenant" });
    expect(cost).toMatchObject({ totalCostUsd: 0.01, upstreamBilled: true, upstreamInferenceCostUsd: 0.42 });
    // The routing fee must NOT become real spend.
    expect(realProviderCostFrom(cost)).toBeNull();
  });

  it("prefers the nested value when BOTH are present", async () => {
    const http = new FakeOpenRouterHttp({
      status: 200,
      body: {
        data: {
          id: "gen-both",
          total_cost: 0.01,
          upstream_inference_cost: 0.1,
          cost_details: { upstream_inference_cost: 0.42 },
        },
      },
    });
    const cost = await queryGenerationCost(http, { generationId: "gen-both", token: "sk-or-tenant" });
    expect(cost?.upstreamInferenceCostUsd).toBe(0.42);
  });

  it("stays NOT upstream-billed when neither placement carries a positive value", async () => {
    // Non-vacuous: the widened read must not start flagging ordinary generations.
    const http = new FakeOpenRouterHttp({
      status: 200,
      body: { data: { id: "gen-plain", total_cost: 0.01, upstream_inference_cost: 0, cost_details: {} } },
    });
    const cost = await queryGenerationCost(http, { generationId: "gen-plain", token: "sk-or-tenant" });
    expect(cost).toMatchObject({ upstreamBilled: false, upstreamInferenceCostUsd: null });
    expect(realProviderCostFrom(cost)).toBe(0.01);
  });
});
