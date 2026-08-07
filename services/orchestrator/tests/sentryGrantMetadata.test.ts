import { describe, expect, it } from "vitest";
import {
  requireSentryGrantMetadata,
  requireSentryPrincipalIdentity,
  sentryPrincipalIdentity,
} from "../src/engine/integrations/sentryPrincipalIdentity.js";

describe("Sentry grant metadata boundary", () => {
  const identity = sentryPrincipalIdentity("acme", "https://sentry.io");

  it("accepts the verified identity and the supported team extension", () => {
    expect(requireSentryGrantMetadata({ ...identity, team: "platform" })).toEqual({
      ...identity,
      team: "platform",
    });
  });

  it("rejects unknown grant extensions", () => {
    expect(() => requireSentryGrantMetadata({ ...identity, unverifiedExtension: "x" })).toThrow(
      /sentry_principal_relink_required/u,
    );
  });

  it("rejects legacy identities even when they carry the supported team", () => {
    expect(() =>
      requireSentryGrantMetadata({ orgSlug: "acme", baseUrl: "https://sentry.io", team: "platform" }),
    ).toThrow(/sentry_principal_relink_required/u);
  });

  it("does not coerce malformed team metadata", () => {
    expect(() => requireSentryGrantMetadata({ ...identity, team: 42 })).toThrow(/sentry_principal_relink_required/u);
  });

  it("keeps the direct identity helper strict", () => {
    expect(() => requireSentryPrincipalIdentity({ ...identity, team: "platform" })).toThrow(
      /sentry_principal_relink_required/u,
    );
  });
});
