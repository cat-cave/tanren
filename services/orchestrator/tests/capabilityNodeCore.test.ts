// Pure-logic proof for the capability_prepare decision core (no DB): provider
// resolution (allowed ∪ preferred minus forbidden) and the stable desired-state hash.

import { describe, expect, it } from "vitest";
import { allowedProviders, capabilityDesiredStateHash } from "../src/engine/integrations/capabilityNodeCore.js";

describe("allowedProviders", () => {
  it("uses allowed minus forbidden", () => {
    expect(allowedProviders({ providerPolicy: { allowed: ["slack", "twilio"], forbidden: ["twilio"] } })).toEqual([
      "slack",
    ]);
  });

  it("falls back to preferred when allowed is unset", () => {
    expect(allowedProviders({ providerPolicy: { preferred: ["slack"] } })).toEqual(["slack"]);
  });

  it("returns empty when everything is forbidden (fail-closed upstream)", () => {
    expect(allowedProviders({ providerPolicy: { allowed: ["slack"], forbidden: ["slack"] } })).toEqual([]);
  });

  it("returns empty on a missing / malformed provider policy", () => {
    expect(allowedProviders({})).toEqual([]);
    expect(allowedProviders(null)).toEqual([]);
    expect(allowedProviders({ providerPolicy: { allowed: [1, "slack"] } })).toEqual(["slack"]);
  });
});

describe("capabilityDesiredStateHash", () => {
  const base = { requirementId: "req_1", environment: "test", requirementSourceDigest: `sha256:${"a".repeat(64)}` };

  it("produces a sha256 digest", () => {
    expect(capabilityDesiredStateHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is stable for the same inputs and varies by environment", () => {
    expect(capabilityDesiredStateHash(base)).toBe(capabilityDesiredStateHash({ ...base }));
    expect(capabilityDesiredStateHash(base)).not.toBe(capabilityDesiredStateHash({ ...base, environment: "preview" }));
  });
});
