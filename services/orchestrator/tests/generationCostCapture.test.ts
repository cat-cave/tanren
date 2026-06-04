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
    const { client, requests } = fakeClient({ data: { total_cost: 0.0421 } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("gen-abc")).toBe(0.0421);
    expect(requests).toEqual(["/generation?id=gen-abc"]);
  });

  it("returns null for an empty generation id (no query)", async () => {
    const { client, requests } = fakeClient({ data: { total_cost: 1 } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("returns null (best-effort, no throw) when OpenRouter returns a non-200 — a missed capture must not fail the run", async () => {
    const { client } = fakeClient({}, 500);
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("gen-xyz")).toBeNull();
  });

  it("returns null when total_cost is absent/non-positive (honest no-capture, never a fabricated $0)", async () => {
    const { client } = fakeClient({ data: { total_cost: 0 } });
    const capture = await buildManagedGenerationCostCapturer({
      secrets: fakeSecrets("sk-or-fake"),
      managedCredentialRef: "credential/openrouter/platform/default",
      endpointBaseUrl: "https://openrouter.ai/api/v1",
      httpClient: client,
    });
    expect(await capture("gen-zero")).toBeNull();
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
