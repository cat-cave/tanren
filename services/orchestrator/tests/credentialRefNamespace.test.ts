import { describe, expect, it } from "vitest";
import { deriveCredentialRef, resolveCredentialName } from "../src/engine/credentials/refNamespace.js";

// SaaS Tier-A #3: the Vault ref is derived server-side from {kind, scope,
// ownerId, name}. These tests pin the exact derived strings and the exact
// rejection on a cross-tenant / malformed ref so the derivation + ownership
// guard survive mutation.

describe("deriveCredentialRef", () => {
  it("derives the org-scoped ref with the kind slug, owner, and name", () => {
    expect(
      deriveCredentialRef({ kind: "codex_chatgpt_auth", scope: "org", ownerId: "org_acme", name: "default" }),
    ).toBe("credential/codex/org/org_acme/default");
    expect(deriveCredentialRef({ kind: "claude_cli_auth", scope: "org", ownerId: "org_acme", name: "default" })).toBe(
      "credential/claude/org/org_acme/default",
    );
    expect(deriveCredentialRef({ kind: "opencode_cli_auth", scope: "org", ownerId: "org_acme", name: "n" })).toBe(
      "credential/opencode/org/org_acme/n",
    );
    expect(deriveCredentialRef({ kind: "github_token", scope: "org", ownerId: "org_acme", name: "ci" })).toBe(
      "credential/github/org/org_acme/ci",
    );
    expect(deriveCredentialRef({ kind: "github_app", scope: "org", ownerId: "org_acme", name: "bot" })).toBe(
      "credential/github_app/org/org_acme/bot",
    );
    expect(deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "org_acme", name: "k" })).toBe(
      "credential/opaque/org/org_acme/k",
    );
  });

  it("derives the me-scoped ref under the user id", () => {
    expect(deriveCredentialRef({ kind: "codex_chatgpt_auth", scope: "me", ownerId: "user_bob", name: "dev" })).toBe(
      "credential/codex/me/user_bob/dev",
    );
  });

  it("trims the name before embedding it", () => {
    expect(deriveCredentialRef({ kind: "opaque", scope: "me", ownerId: "user_bob", name: "  dev  " })).toBe(
      "credential/opaque/me/user_bob/dev",
    );
  });

  it("rejects a name carrying extra path segments (no tenant climb)", () => {
    expect(() =>
      deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "org_acme", name: "../org_evil/key" }),
    ).toThrow(/single safe path segment/u);
    expect(() => deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "org_acme", name: "a/b" })).toThrow(
      /single safe path segment/u,
    );
  });

  it("rejects an empty name and an unsafe owner id", () => {
    expect(() => deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "org_acme", name: "" })).toThrow(
      /single safe path segment/u,
    );
    expect(() => deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "../evil", name: "k" })).toThrow(
      /owner id is not a safe ref segment/u,
    );
  });
});

describe("resolveCredentialName", () => {
  it("returns a bare name unchanged (after trimming)", () => {
    expect(
      resolveCredentialName({ supplied: "default", kind: "github_token", scope: "org", ownerId: "org_acme" }),
    ).toBe("default");
    expect(resolveCredentialName({ supplied: "  ci  ", kind: "github_token", scope: "org", ownerId: "org_acme" })).toBe(
      "ci",
    );
  });

  it("extracts the trailing name from a matching full ref (back-compat)", () => {
    expect(
      resolveCredentialName({
        supplied: "credential/github/org/org_acme/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toBe("ci");
  });

  it("rejects a full ref whose owner segment names a different tenant", () => {
    expect(() =>
      resolveCredentialName({
        supplied: "credential/github/org/org_evil/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toThrow(/does not belong to the authenticated owner/u);
  });

  it("rejects a full ref whose scope segment is wrong for the route", () => {
    expect(() =>
      resolveCredentialName({
        supplied: "credential/github/me/org_acme/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toThrow(/does not belong to the authenticated owner/u);
  });

  it("rejects a full ref whose kind slug is wrong for the route", () => {
    expect(() =>
      resolveCredentialName({
        supplied: "credential/codex/org/org_acme/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toThrow(/does not belong to the authenticated owner/u);
  });

  it("rejects a full ref that has extra trailing segments", () => {
    expect(() =>
      resolveCredentialName({
        supplied: "credential/github/org/org_acme/a/b",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toThrow(/single name segment/u);
  });

  it("rejects an empty supplied value", () => {
    expect(() => resolveCredentialName({ supplied: "   ", kind: "opaque", scope: "me", ownerId: "user_bob" })).toThrow(
      /must not be empty/u,
    );
  });
});
