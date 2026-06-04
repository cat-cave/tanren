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
  it("extracts OpenRouter's REAL total_cost (the platform deduction) from the generation row", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: { data: { id: "gen-1", total_cost: 0.0421 } } });
    const cost = await queryGenerationCost(http, {
      generationId: "gen-1",
      token: "sk-or-test",
      billingModel: "platform",
    });
    expect(cost).toEqual({ generationId: "gen-1", totalCostUsd: 0.0421, upstreamBilled: false });
    // The query hits the documented /generation?id= endpoint with the key as bearer.
    expect(http.lastRequest?.path).toBe("/generation?id=gen-1");
    expect(http.lastRequest?.token).toBe("sk-or-test");
    // A platform-billed figure IS the authoritative real spend.
    expect(realProviderCostFrom(cost)).toBe(0.0421);
  });

  it("BYOK GOTCHA: a bring-your-own-key call's total_cost is the routing figure, NOT the real upstream bill — flagged and NOT recorded as real spend", async () => {
    // Under BYOK, OpenRouter's total_cost is its credit/routing figure; the REAL
    // spend lands on the upstream provider's bill. So it must NOT set real spend
    // (that would undercount the true charge). realProviderCostFrom returns null.
    const http = new FakeOpenRouterHttp({ status: 200, body: { data: { id: "gen-byok", total_cost: 0.01 } } });
    const cost = await queryGenerationCost(http, {
      generationId: "gen-byok",
      token: "sk-or-tenant",
      billingModel: "byok",
    });
    expect(cost).toMatchObject({ totalCostUsd: 0.01, upstreamBilled: true });
    // The authoritative real-spend figure is deliberately null for BYOK.
    expect(realProviderCostFrom(cost)).toBeNull();
  });

  it("returns null for an absent/non-positive total_cost (honest no-capture, never a fabricated $0)", async () => {
    for (const body of [{ data: { id: "g" } }, { data: { id: "g", total_cost: 0 } }, { data: { total_cost: -1 } }]) {
      const http = new FakeOpenRouterHttp({ status: 200, body });
      const cost = await queryGenerationCost(http, { generationId: "g", token: "t", billingModel: "platform" });
      expect(cost).toBeNull();
      expect(realProviderCostFrom(cost)).toBeNull();
    }
  });

  it("also reads a top-level (unwrapped) cost field and the `cost` alias", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: { id: "g2", cost: 0.005 } });
    const cost = await queryGenerationCost(http, { generationId: "g2", token: "t", billingModel: "platform" });
    expect(cost?.totalCostUsd).toBe(0.005);
  });

  it("throws LOUDLY on a non-200 (transport/auth failure is never a silent miss)", async () => {
    const http = new FakeOpenRouterHttp({ status: 404, body: {} });
    await expect(
      queryGenerationCost(http, { generationId: "missing", token: "t", billingModel: "platform" }),
    ).rejects.toThrow(/status 404/u);
  });

  it("requires a non-empty generation id", async () => {
    const http = new FakeOpenRouterHttp({ status: 200, body: {} });
    await expect(queryGenerationCost(http, { generationId: "", token: "t", billingModel: "platform" })).rejects.toThrow(
      /generationId is required/u,
    );
  });
});
