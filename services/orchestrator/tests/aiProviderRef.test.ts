// Wave-2 operator API: the cost-classification invariant for connected AI
// providers. The connect route's whole reason to exist is that the secret lands
// under a ref whose PREFIX `classifyAuthRef` prices — so the budget gate meters
// it. These tests pin that the derived ref for EVERY provider classifies
// correctly (an openrouter key MUST be per_token/openrouter), and that the
// derivation refuses an unsafe `name` segment.

import { describe, expect, it } from "vitest";
import { classifyAuthRef } from "../src/engine/costs/sources.js";
import { AI_PROVIDERS, classifiedAsLabel, deriveAiProviderRef } from "../src/engine/credentials/aiProvider.js";

describe("ai-provider ref classification", () => {
  const cases = [
    { provider: "openrouter", prefix: "credential/openrouter/", billingMode: "per_token", providerName: "openrouter" },
    { provider: "anthropic", prefix: "credential/anthropic/", billingMode: "per_token", providerName: "anthropic" },
    { provider: "openai", prefix: "credential/openai-api/", billingMode: "per_token", providerName: "openai" },
    { provider: "codex", prefix: "credential/codex/", billingMode: "subscription", providerName: "openai" },
  ] as const;

  for (const { provider, prefix, billingMode, providerName } of cases) {
    it(`derives a ${billingMode} ref for ${provider} that classifyAuthRef prices`, () => {
      const ref = deriveAiProviderRef({ provider, scope: "org", ownerId: "org_acme", name: "default" });
      expect(ref).toBe(`${prefix}org/org_acme/default`);
      const classification = classifyAuthRef(ref);
      expect(classification.billingMode).toBe(billingMode);
      expect(classification.provider).toBe(providerName);
      expect(classifiedAsLabel(ref)).toBe(`${billingMode}/${providerName}`);
    });
  }

  it("never classifies a connected provider ref as unrecognized/unattributed", () => {
    for (const provider of AI_PROVIDERS) {
      const ref = deriveAiProviderRef({ provider, scope: "me", ownerId: "user_x", name: "k" });
      const billingMode = classifyAuthRef(ref).billingMode;
      expect(["per_token", "subscription"]).toContain(billingMode);
      expect(billingMode).not.toBe("unrecognized");
    }
  });

  it("rejects a name segment that would escape the tenant prefix", () => {
    expect(() =>
      deriveAiProviderRef({ provider: "openrouter", scope: "org", ownerId: "org_acme", name: "a/b" }),
    ).toThrow(/single safe path segment/u);
    expect(() =>
      deriveAiProviderRef({ provider: "openrouter", scope: "org", ownerId: "bad/owner", name: "default" }),
    ).toThrow(/safe ref segment/u);
  });
});
