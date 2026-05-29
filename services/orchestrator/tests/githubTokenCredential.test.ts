import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import {
  storeGithubToken,
  validateGithubCredentialRef,
  validateGithubToken,
} from "../src/engine/credentials/githubToken.js";

// Behaviour pins for the github_token validator + store. The mutation baseline
// left the trim/whitespace branches and the namespace prefix check uncovered.

describe("validateGithubToken", () => {
  it("trims surrounding whitespace (spaces, tabs, newlines) and returns the bare token", () => {
    expect(validateGithubToken("  ghp_abc  ")).toBe("ghp_abc");
    const padded = `\t${"ghp_xyz"}\n`;
    expect(validateGithubToken(padded)).toBe("ghp_xyz");
  });

  it("rejects an empty / whitespace-only token", () => {
    expect(() => validateGithubToken("")).toThrow("must not be empty");
    expect(() => validateGithubToken("   ")).toThrow("must not be empty");
  });

  it("rejects a token containing interior whitespace", () => {
    expect(() => validateGithubToken("ghp ab")).toThrow("must not contain whitespace");
    expect(() => validateGithubToken("ghp\tab")).toThrow("must not contain whitespace");
  });
});

describe("validateGithubCredentialRef", () => {
  it("accepts a credential/github/ ref and returns it verbatim", () => {
    expect(validateGithubCredentialRef("credential/github/org/o1/ci")).toBe("credential/github/org/o1/ci");
  });

  it("rejects refs outside the credential/github/ namespace", () => {
    expect(() => validateGithubCredentialRef("credential/github_app/org/o1/x")).toThrow("credential/github/");
    expect(() => validateGithubCredentialRef("credential/codex/org/o1/x")).toThrow("credential/github/");
  });
});

describe("storeGithubToken", () => {
  it("stores the trimmed token under the validated ref and redacts the result", async () => {
    const secrets = new FakeSecretStore();
    const result = await storeGithubToken(secrets, {
      ref: "credential/github/org/o1/ci",
      token: "  ghp_secret  ",
    });
    expect(result).toEqual({
      credentialKind: "github_token",
      ref: "credential/github/org/o1/ci",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
    // The stored secret is the trimmed token value.
    expect((await secrets.get("credential/github/org/o1/ci"))?.value).toBe("ghp_secret");
  });

  it("rejects an out-of-namespace ref before writing anything", async () => {
    const secrets = new FakeSecretStore();
    await expect(storeGithubToken(secrets, { ref: "credential/codex/org/o1/ci", token: "ghp_secret" })).rejects.toThrow(
      "credential/github/",
    );
    expect(await secrets.get("credential/codex/org/o1/ci")).toBeUndefined();
  });
});
