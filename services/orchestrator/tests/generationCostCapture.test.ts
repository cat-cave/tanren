import { describe, expect, it } from "vitest";
import { buildManagedGenerationCostCapturer } from "../src/engine/costs/generationCostCapture.js";
import type { OpenRouterHttpClient } from "../src/engine/costs/openRouterCost.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";

// A SecretStore that resolves the managed OpenRouter ref to a fake key.
function fakeSecrets(key: string): SecretStore {
  return {
    async get(ref: string) {
      return ref === "credential/openrouter/platform/default" ? { value: key } : undefined;
    },
  } as unknown as SecretStore;
}

// A fake OpenRouter transport returning a scripted /generation body.
function fakeClient(body: unknown, status = 200): { client: OpenRouterHttpClient; requests: string[] } {
  const requests: string[] = [];
  const client: OpenRouterHttpClient = {
    async request(input) {
      requests.push(input.path);
      return { status, body };
    },
  };
  return { client, requests };
}

describe("buildManagedGenerationCostCapturer", () => {
  it("resolves the platform key once and returns OpenRouter's REAL total_cost for a generation id", async () => {
    // A managed platform generation: OpenRouter is the biller, so it reports
    // is_byok:false and total_cost IS the authoritative real deduction.
    const { client, requests } = fakeClient({ data: { total_cost: 0.0421, is_byok: false } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("gen-abc")).toEqual({ cost: 0.0421 });
    expect(requests).toEqual(["/generation?id=gen-abc"]);
  });

  it("returns `{ cost: null }` for an empty generation id (no query — honest no-capture)", async () => {
    const { client, requests } = fakeClient({ data: { total_cost: 1 } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("")).toEqual({ cost: null });
    expect(requests).toEqual([]);
  });

  it("LOUD `{ failed }` (no throw) when OpenRouter returns a non-200 — authoritative platform spend must not silently vanish", async () => {
    const { client } = fakeClient({}, 500);
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    const result = await capture("gen-xyz");
    expect(result).toMatchObject({ failed: { generationId: "gen-xyz", detail: expect.stringContaining("500") } });
  });

  it("returns `{ cost: null }` when total_cost is absent/non-positive (honest no-capture, never a fabricated $0)", async () => {
    const { client } = fakeClient({ data: { total_cost: 0 } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("gen-zero")).toEqual({ cost: null });
  });

  it("LOUD: a missing managed credential ref throws at build time (no silent degrade)", async () => {
    const { client } = fakeClient({ data: { total_cost: 1 } });
    await expect(
      buildManagedGenerationCostCapturer({
        secrets: fakeSecrets("sk-or-fake"),
        managedCredentialRef: "credential/openrouter/missing",
        endpointBaseUrl: "https://openrouter.ai/api/v1",
        httpClient: client,
      }),
    ).rejects.toThrow(/missing managed LLM credential ref/u);
  });
});
