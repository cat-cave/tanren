// Mutation-strength pins for engine/credentials/** (issue #838 / CX-045).
//
// Prefer pure outcome asserts (returned refs, thrown messages, stored secret
// values) over spies. Each case targets a branch Stryker commonly survives when
// only the higher-level route/materializer suites run.

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import {
  codexAuthKind,
  redactedCodexAuthResult,
  storeCodexAuthBundle,
  validateCodexAuthBundle,
  validateCodexCredentialRef,
  validateCredentialRef,
} from "../src/engine/credentials/codexAuth.js";
import {
  claudeAuthKind,
  redactedClaudeAuthResult,
  storeClaudeAuthBundle,
  validateClaudeAuthBundle,
  validateClaudeCredentialRef,
} from "../src/engine/credentials/claudeAuth.js";
import {
  opencodeAuthKind,
  redactedOpencodeAuthResult,
  storeOpencodeAuthBundle,
  validateOpencodeAuthBundle,
  validateOpencodeCredentialRef,
  ZAI_PROVIDER_ID,
} from "../src/engine/credentials/opencodeAuth.js";
import {
  CREDENTIAL_TYPES,
  credentialTypeForRef,
  providerSlugForRef,
} from "../src/engine/credentials/credentialType.js";
import {
  githubTokenKind,
  normalizeStaticGithubRef,
  redactedGithubTokenResult,
  storeGithubToken,
  validateGithubCredentialRef,
  validateGithubToken,
} from "../src/engine/credentials/githubToken.js";
import { resolveRawProviderKey } from "../src/engine/credentials/managedKey.js";
import {
  canonicalOrgGithubCredentialRef,
  canonicalOrgLlmCredentialRef,
  CredentialRefOwnershipError,
  deriveImportRef,
} from "../src/engine/credentials/refNamespace.js";
import {
  githubCredentialRefForWire,
  type ResolvedGithubCredential,
} from "../src/engine/credentials/resolveCredentials.js";

describe("codexAuth — validation branches that survive weak suites", () => {
  it("accepts every recognized token field and rejects empty/non-object tokens", () => {
    for (const field of ["access_token", "refresh_token", "id_token"] as const) {
      const bundle = validateCodexAuthBundle(JSON.stringify({ tokens: { [field]: "tok" } }));
      expect(JSON.parse(bundle.authJson)).toEqual({ tokens: { [field]: "tok" } });
    }
    expect(() => validateCodexAuthBundle(JSON.stringify({ tokens: { access_token: 1 } }))).toThrow(
      "Codex ChatGPT token fields",
    );
    // auth_mode alone is insufficient without a real token field.
    expect(() => validateCodexAuthBundle(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }))).toThrow(
      "Codex ChatGPT token fields",
    );
  });

  it("canonicalizes the stored JSON (object → stable stringify) and redacts the import result", async () => {
    const secrets = new FakeSecretStore();
    const result = await storeCodexAuthBundle(secrets, {
      ref: "credential/codex/org/o1/default",
      authJson: '{"tokens":{"access_token":"secret-tok"}}',
    });
    expect(result).toEqual(redactedCodexAuthResult("credential/codex/org/o1/default"));
    expect(result.credentialKind).toBe(codexAuthKind);
    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-tok");
    const stored = await secrets.get("credential/codex/org/o1/default");
    // Re-stringify normalizes formatting; secret still present in Vault only.
    expect(stored?.value).toBe(JSON.stringify({ tokens: { access_token: "secret-tok" } }));
  });

  it("requires the credential/codex/ prefix after the shared grammar check", () => {
    expect(validateCodexCredentialRef("credential/codex/org/o1/x")).toBe("credential/codex/org/o1/x");
    expect(() => validateCodexCredentialRef("credential/claude/org/o1/x")).toThrow("credential/codex/");
    // Grammar fails first (message names the ref).
    expect(() => validateCredentialRef("credential//codex/x")).toThrow(
      'credential ref has an invalid format: "credential//codex/x"',
    );
  });
});

describe("claudeAuth / opencodeAuth — store + validator pins", () => {
  it("claude: stores OAuth bundle under credential/claude/ and never echoes the token", async () => {
    const secrets = new FakeSecretStore();
    const authJson = JSON.stringify({ claudeAiOauth: { accessToken: "claude-secret" } });
    const result = await storeClaudeAuthBundle(secrets, { ref: "credential/claude/org/o1/default", authJson });
    expect(result).toEqual(redactedClaudeAuthResult("credential/claude/org/o1/default"));
    expect(result.credentialKind).toBe(claudeAuthKind);
    expect(JSON.stringify(result)).not.toContain("claude-secret");
    expect((await secrets.get("credential/claude/org/o1/default"))?.value).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-secret" } }),
    );
    expect(() => validateClaudeCredentialRef("credential/codex/org/o1/x")).toThrow("credential/claude/");
    expect(() => validateClaudeAuthBundle("[]")).toThrow("must be a JSON object");
  });

  it("opencode: requires a Zai entry with a non-empty recognized key field", async () => {
    const secrets = new FakeSecretStore();
    for (const field of ["key", "apiKey", "api_key", "access", "accessToken"] as const) {
      const authJson = JSON.stringify({ [ZAI_PROVIDER_ID]: { [field]: "zai-secret" } });
      expect(validateOpencodeAuthBundle(authJson).authJson).toContain(ZAI_PROVIDER_ID);
    }
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ zai: { key: "" } }))).toThrow("Zai GLM provider entry");
    expect(() => validateOpencodeAuthBundle(JSON.stringify({ wafer: { key: "x" } }))).toThrow("Zai GLM provider entry");
    const result = await storeOpencodeAuthBundle(secrets, {
      ref: "credential/opencode/org/o1/default",
      authJson: JSON.stringify({ zai: { key: "zai-secret" } }),
    });
    expect(result).toEqual(redactedOpencodeAuthResult("credential/opencode/org/o1/default"));
    expect(result.credentialKind).toBe(opencodeAuthKind);
    expect(JSON.stringify(result)).not.toContain("zai-secret");
    expect(() => validateOpencodeCredentialRef("credential/claude/org/o1/x")).toThrow("credential/opencode/");
  });
});

describe("credentialType — slug parse + taxonomy", () => {
  it("providerSlugForRef extracts only the first path segment after credential/", () => {
    expect(providerSlugForRef("credential/openrouter/org/o1/default")).toBe("openrouter");
    expect(providerSlugForRef("credential/openai-api/me/u1/k")).toBe("openai-api");
    expect(providerSlugForRef("credential/codex/")).toBe("codex");
    // No trailing slash after slug → not a credential/<slug>/… ref.
    expect(providerSlugForRef("credential/codex")).toBeNull();
    expect(providerSlugForRef("not-a-ref")).toBeNull();
    expect(providerSlugForRef("")).toBeNull();
  });

  it("credentialTypeForRef maps every known LLM slug and returns null otherwise", () => {
    expect(credentialTypeForRef("credential/codex/org/o1/d")).toBe("codex_chatgpt_bundle");
    expect(credentialTypeForRef("credential/claude/org/o1/d")).toBe("claude_cli_bundle");
    expect(credentialTypeForRef("credential/opencode/org/o1/d")).toBe("opencode_bundle");
    for (const slug of ["openrouter", "anthropic", "openai-api"] as const) {
      expect(credentialTypeForRef(`credential/${slug}/org/o1/d`)).toBe("api_key");
    }
    expect(credentialTypeForRef("credential/github/org/o1/d")).toBeNull();
    expect(credentialTypeForRef("credential/github_app/org/o1/d")).toBeNull();
    expect(credentialTypeForRef("credential/opaque/org/o1/d")).toBeNull();
    // Exact taxonomy set — a dropped/renamed type is a mutation kill.
    expect([...CREDENTIAL_TYPES].sort()).toEqual(
      ["api_key", "claude_cli_bundle", "codex_chatgpt_bundle", "opencode_bundle"].sort(),
    );
  });
});

describe("githubToken + managedKey pure seams", () => {
  it("normalizeStaticGithubRef collapses empty/blank to undefined and validates non-empty refs", () => {
    const missing: string | undefined = undefined;
    expect(normalizeStaticGithubRef(missing)).toBeUndefined();
    expect(normalizeStaticGithubRef("")).toBeUndefined();
    expect(normalizeStaticGithubRef("   ")).toBeUndefined();
    expect(normalizeStaticGithubRef("credential/github/org/o1/ci")).toBe("credential/github/org/o1/ci");
    expect(() => normalizeStaticGithubRef("credential/github_app/org/o1/x")).toThrow("credential/github/");
  });

  it("storeGithubToken trims, stores, and redacts; reject before put on bad input", async () => {
    const secrets = new FakeSecretStore();
    const padded = `\t${"ghp_ok"}\n`;
    const ok = await storeGithubToken(secrets, { ref: "credential/github/org/o1/ci", token: padded });
    expect(ok).toEqual(redactedGithubTokenResult("credential/github/org/o1/ci"));
    expect(ok.credentialKind).toBe(githubTokenKind);
    expect((await secrets.get("credential/github/org/o1/ci"))?.value).toBe("ghp_ok");
    expect(validateGithubToken("ghp_ok")).toBe("ghp_ok");
    expect(() => validateGithubToken("a b")).toThrow("must not contain whitespace");
    expect(() => validateGithubCredentialRef("credential/codex/x")).toThrow("credential/github/");
  });

  it("resolveRawProviderKey returns the trimmed key and fails loud on missing/empty", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "  sk-live  " });
    await expect(resolveRawProviderKey(secrets, "credential/openrouter/platform/default")).resolves.toBe("sk-live");
    await expect(resolveRawProviderKey(secrets, "credential/openrouter/platform/missing")).rejects.toThrow(
      "missing managed LLM credential ref: credential/openrouter/platform/missing",
    );
    await secrets.put({ ref: "credential/openrouter/platform/blank", value: " \t " });
    await expect(resolveRawProviderKey(secrets, "credential/openrouter/platform/blank")).rejects.toThrow(
      "resolved to an empty api key",
    );
    // Grammar check runs first — malformed ref never hits the secret store.
    await expect(resolveRawProviderKey(secrets, "credential//bad")).rejects.toThrow("invalid format");
  });
});

describe("refNamespace — deriveImportRef + org-canonical gates", () => {
  it("deriveImportRef accepts bare names and byte-equal full refs only", () => {
    expect(
      deriveImportRef({
        supplied: "default",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toBe("credential/github/org/org_acme/default");
    expect(
      deriveImportRef({
        supplied: "credential/github/org/org_acme/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toBe("credential/github/org/org_acme/ci");
    expect(() =>
      deriveImportRef({
        supplied: "credential/github/org/org_evil/ci",
        kind: "github_token",
        scope: "org",
        ownerId: "org_acme",
      }),
    ).toThrow(/does not belong to the authenticated owner/u);
  });

  it("canonicalOrgGithubCredentialRef wraps mismatches as CredentialRefOwnershipError", () => {
    expect(canonicalOrgGithubCredentialRef({ orgId: "org_acme", supplied: "bot", kind: "github_app" })).toBe(
      "credential/github_app/org/org_acme/bot",
    );
    expect(() =>
      canonicalOrgGithubCredentialRef({
        orgId: "org_acme",
        supplied: "credential/github/org/org_evil/ci",
        kind: "github_token",
      }),
    ).toThrow(CredentialRefOwnershipError);
    // Capture properties without a conditional expect.
    let captured: unknown;
    try {
      canonicalOrgGithubCredentialRef({
        orgId: "org_acme",
        supplied: "credential/github/org/org_evil/ci",
        kind: "github_token",
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(CredentialRefOwnershipError);
    const typed = captured as CredentialRefOwnershipError;
    expect(typed.name).toBe("CredentialRefOwnershipError");
    expect(typed.retriable).toBe(false);
    expect(typed.credentialKind).toBe("github_token");
    // Hostile ref must not be echoed in the typed error message.
    expect(typed.message).not.toContain("org_evil");
  });

  it("canonicalOrgLlmCredentialRef requires credential/<slug>/org/<orgId>/<name>", () => {
    expect(
      canonicalOrgLlmCredentialRef({ orgId: "org_acme", supplied: "credential/openrouter/org/org_acme/default" }),
    ).toBe("credential/openrouter/org/org_acme/default");
    expect(canonicalOrgLlmCredentialRef({ orgId: "org_acme", supplied: "credential/codex/org/org_acme/default" })).toBe(
      "credential/codex/org/org_acme/default",
    );
    // Wrong scope, wrong owner, too short, too long, bare junk, blank.
    const rejects = [
      "credential/openrouter/me/org_acme/default",
      "credential/openrouter/org/org_evil/default",
      "credential/openrouter/org/org_acme",
      "credential/openrouter/org/org_acme/default/extra",
      "not-a-ref",
      "  ",
    ];
    for (const supplied of rejects) {
      expect(() => canonicalOrgLlmCredentialRef({ orgId: "org_acme", supplied })).toThrow(CredentialRefOwnershipError);
    }
    // Unsafe org id fails before segment parse.
    expect(() =>
      canonicalOrgLlmCredentialRef({ orgId: "../evil", supplied: "credential/openrouter/org/../evil/d" }),
    ).toThrow(CredentialRefOwnershipError);
  });
});

describe("resolveCredentials wire collapse", () => {
  it("githubCredentialRefForWire maps static ref vs empty App sentinel", () => {
    const staticCred: ResolvedGithubCredential = { kind: "static", ref: "credential/github/org/o1/ci" };
    const appCred: ResolvedGithubCredential = { kind: "app" };
    expect(githubCredentialRefForWire(staticCred)).toBe("credential/github/org/o1/ci");
    expect(githubCredentialRefForWire(appCred)).toBe("");
    // App sentinel must be exactly empty string (not undefined / whitespace).
    expect(githubCredentialRefForWire(appCred)).toHaveLength(0);
  });
});
