// in-2: golden vectors for IntegrationRequirementV1 plane separation + digests.

import { describe, expect, it } from "vitest";
import {
  goldenControlNotifyRequirement,
  goldenCrossPlaneForbiddenRequirement,
  goldenProductMessagingRequirement,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../src/engine/contracts/integrationRequirement.js";

describe("IntegrationRequirementV1 golden vectors (in-2)", () => {
  it("accepts product messaging.send with product binding kinds", () => {
    const result = parseIntegrationRequirement(goldenProductMessagingRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.plane).toBe("product");
    expect(result.requirement.capability).toBe("messaging.send");
    const digest = integrationRequirementDigest(result.requirement);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Stable digest across calls.
    expect(integrationRequirementDigest(result.requirement)).toBe(digest);
  });

  it("accepts control control.notify with control binding kinds", () => {
    const result = parseIntegrationRequirement(goldenControlNotifyRequirement());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement.plane).toBe("control");
    expect(result.requirement.bindingOutputs.every((o) => o.kind.startsWith("control."))).toBe(true);
  });

  it("rejects control credential shape claimed as product messaging (wrong-plane Slack)", () => {
    const result = parseIntegrationRequirement(goldenCrossPlaneForbiddenRequirement());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(["binding_plane_mismatch", "control_credential_as_product_messaging"]),
    );
  });

  it("rejects forbidden provider that is also preferred", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      providerPolicy: { preferred: ["slack"], allowed: ["slack"], forbidden: ["slack"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "provider_preferred_forbidden")).toBe(true);
  });

  it("rejects missing expected effect (schema)", () => {
    const base = goldenProductMessagingRequirement() as Record<string, unknown>;
    delete base.expectedEffect;
    const result = parseIntegrationRequirement(base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "schema")).toBe(true);
  });

  it("rejects empty requiredScopes (schema)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({ ...base, requiredScopes: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects capability/plane mismatch (messaging.send on control)", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      plane: "control",
      expectedEffect: { ...base.expectedEffect, plane: "control" },
      bindingOutputs: goldenControlNotifyRequirement().bindingOutputs,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "plane_capability_mismatch")).toBe(true);
  });

  it("rejects secret-shaped values in free text", () => {
    const base = goldenProductMessagingRequirement();
    const result = parseIntegrationRequirement({
      ...base,
      trigger: {
        ...base.trigger,
        description: "token xoxb-1234567890-abcdefghijklmnop embedded",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "secret_value_forbidden")).toBe(true);
  });

  it("product and control digests differ", () => {
    const product = parseIntegrationRequirement(goldenProductMessagingRequirement());
    const control = parseIntegrationRequirement(goldenControlNotifyRequirement());
    expect(product.ok && control.ok).toBe(true);
    if (!product.ok || !control.ok) return;
    expect(integrationRequirementDigest(product.requirement)).not.toBe(
      integrationRequirementDigest(control.requirement),
    );
  });
});
