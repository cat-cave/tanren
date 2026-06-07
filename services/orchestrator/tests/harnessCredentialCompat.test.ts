import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TYPES,
  credentialTypeForRef,
  type CredentialType,
} from "../src/engine/credentials/credentialType.js";
import { deriveCredentialRef } from "../src/engine/credentials/refNamespace.js";
import { AI_PROVIDERS, deriveAiProviderRef } from "../src/engine/credentials/aiProvider.js";
import {
  FULL_ROLE_CLIS,
  HARNESS_CAPABILITIES,
  harnessAcceptsCredentialType,
  harnessCanBeDefault,
} from "../src/engine/providers/harnessCapability.js";

// Pins the credential-type taxonomy + harness compatibility matrix to the
// AUTHORITATIVE ref derivers and the harness table, so a renamed slug or a
// materializer change cannot silently re-open the multi-provider facade bug.

describe("credentialTypeForRef inference (pinned to the real ref derivers)", () => {
  it("infers bundle types for refs from the namespaced bundle kinds", () => {
    const cases: Array<{ kind: "codex_chatgpt_auth" | "claude_cli_auth" | "opencode_cli_auth"; type: CredentialType }> =
      [
        { kind: "codex_chatgpt_auth", type: "codex_chatgpt_bundle" },
        { kind: "claude_cli_auth", type: "claude_cli_bundle" },
        { kind: "opencode_cli_auth", type: "opencode_bundle" },
      ];
    for (const { kind, type } of cases) {
      const ref = deriveCredentialRef({ kind, scope: "org", ownerId: "o1", name: "default" });
      expect(credentialTypeForRef(ref)).toBe(type);
    }
  });

  it("infers api_key for raw-key providers and the codex bundle for codex", () => {
    for (const provider of AI_PROVIDERS) {
      const ref = deriveAiProviderRef({ provider, scope: "org", ownerId: "o1", name: "default" });
      const expected: CredentialType = provider === "codex" ? "codex_chatgpt_bundle" : "api_key";
      expect(credentialTypeForRef(ref)).toBe(expected);
    }
  });

  it("returns null for non-LLM and unrecognized refs (loud-by-omission, no default guess)", () => {
    expect(
      credentialTypeForRef(deriveCredentialRef({ kind: "github_token", scope: "org", ownerId: "o1", name: "d" })),
    ).toBeNull();
    expect(
      credentialTypeForRef(deriveCredentialRef({ kind: "opaque", scope: "org", ownerId: "o1", name: "d" })),
    ).toBeNull();
    expect(credentialTypeForRef("credential/unknownslug/org/o1/default")).toBeNull();
    expect(credentialTypeForRef("not-a-credential-ref")).toBeNull();
  });
});

describe("harness credential-type compatibility matrix", () => {
  it("every harness declares at least one accepted credential-type, all in the taxonomy", () => {
    for (const capability of HARNESS_CAPABILITIES) {
      expect(capability.acceptedCredentialTypes.length).toBeGreaterThan(0);
      for (const type of capability.acceptedCredentialTypes) {
        expect(CREDENTIAL_TYPES).toContain(type);
      }
    }
  });

  it("reflects today's materializer reality (codex/claude bundles, aider/pi/reasonix keys, opencode bundle)", () => {
    const expected: Record<string, readonly CredentialType[]> = {
      codex: ["codex_chatgpt_bundle"],
      claude: ["claude_cli_bundle"],
      opencode: ["opencode_bundle"],
      aider: ["api_key"],
      pi: ["api_key"],
      reasonix: ["api_key"],
    };
    for (const capability of HARNESS_CAPABILITIES) {
      expect(capability.acceptedCredentialTypes).toEqual(expected[capability.cli]);
    }
  });

  it("harnessAcceptsCredentialType gates (cli, credential-type) pairs", () => {
    expect(harnessAcceptsCredentialType("codex", "codex_chatgpt_bundle")).toBe(true);
    // codex+api_key is false until the BYOK widening (PR-2); pinned so the step is explicit.
    expect(harnessAcceptsCredentialType("codex", "api_key")).toBe(false);
    expect(harnessAcceptsCredentialType("aider", "api_key")).toBe(true);
    expect(harnessAcceptsCredentialType("aider", "codex_chatgpt_bundle")).toBe(false);
    expect(harnessAcceptsCredentialType("nonexistent", "api_key")).toBe(false);
  });
});

describe("default-eligible (full-role) harnesses", () => {
  it("only full-role (write+answer) clis can back a default LLM", () => {
    expect([...FULL_ROLE_CLIS].sort()).toEqual(["claude", "codex"]);
    expect(harnessCanBeDefault("codex")).toBe(true);
    expect(harnessCanBeDefault("claude")).toBe(true);
    // aider/opencode are writer-only, so ineligible to back a full-role default.
    expect(harnessCanBeDefault("aider")).toBe(false);
    expect(harnessCanBeDefault("opencode")).toBe(false);
    expect(harnessCanBeDefault("nonexistent")).toBe(false);
  });
});
