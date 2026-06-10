import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { optionalSecretFromFileOrEnv, requireSecretFromFileOrEnv } from "../src/engine/contracts/secretStoreFactory.js";
import { resolveSidecarAuthToken } from "../src/engine/allocators/sidecarHttpAllocator.js";

// Codex r5 (deploy-secret residual): the file-preferred resolvers the prod compose
// relies on so the GitHub OAuth client secret + the allocator bearer token are
// MOUNTED FILES, never plaintext env. Same precedence as VAULT_TOKEN_FILE: a file
// path WINS; a configured-but-empty/unreadable file is a HARD failure.

function writeSecretFile(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tanren-secret-file-")), "secret");
  writeFileSync(file, contents);
  return file;
}

describe("requireSecretFromFileOrEnv (OAuth + allocator-token prod reads)", () => {
  it("prefers the mounted file over the plaintext env (file WINS)", () => {
    const file = writeSecretFile("file-oauth-secret\n");
    expect(
      requireSecretFromFileOrEnv(
        { TANREN_GITHUB_OAUTH_CLIENT_SECRET: "env-secret", TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE: file },
        "TANREN_GITHUB_OAUTH_CLIENT_SECRET",
        "GitHub OAuth client secret",
      ),
    ).toBe("file-oauth-secret");
    rmSync(file, { force: true });
  });

  it("falls back to the plaintext env when no file is set (dev convenience)", () => {
    expect(
      requireSecretFromFileOrEnv({ TANREN_ALLOCATOR_TOKEN: "dev-token" }, "TANREN_ALLOCATOR_TOKEN", "allocator token"),
    ).toBe("dev-token");
  });

  it("fails LOUD when the file is missing or empty (never a silent blank)", () => {
    expect(() =>
      requireSecretFromFileOrEnv(
        { TANREN_ALLOCATOR_TOKEN_FILE: "/no/such/alloc-token" },
        "TANREN_ALLOCATOR_TOKEN",
        "allocator token",
      ),
    ).toThrow(/TANREN_ALLOCATOR_TOKEN_FILE=.*could not be read/u);
    const empty = writeSecretFile("  \n");
    expect(() =>
      requireSecretFromFileOrEnv({ TANREN_ALLOCATOR_TOKEN_FILE: empty }, "TANREN_ALLOCATOR_TOKEN", "allocator token"),
    ).toThrow(/TANREN_ALLOCATOR_TOKEN_FILE=.*is empty/u);
    rmSync(empty, { force: true });
  });
});

describe("optionalSecretFromFileOrEnv (the optional OAuth client secret)", () => {
  it("returns undefined when NEITHER the file nor the env is set (optional credential)", () => {
    expect(
      optionalSecretFromFileOrEnv({}, "TANREN_GITHUB_OAUTH_CLIENT_SECRET", "GitHub OAuth client secret"),
    ).toBeUndefined();
  });

  it("resolves file-preferred when configured; a present-but-empty file is a hard failure", () => {
    const file = writeSecretFile("opt-file-secret");
    expect(
      optionalSecretFromFileOrEnv(
        { TANREN_GITHUB_OAUTH_CLIENT_SECRET: "env", TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE: file },
        "TANREN_GITHUB_OAUTH_CLIENT_SECRET",
        "GitHub OAuth client secret",
      ),
    ).toBe("opt-file-secret");
    rmSync(file, { force: true });
    const empty = writeSecretFile("");
    expect(() =>
      optionalSecretFromFileOrEnv(
        { TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE: empty },
        "TANREN_GITHUB_OAUTH_CLIENT_SECRET",
        "GitHub OAuth client secret",
      ),
    ).toThrow(/is empty/u);
    rmSync(empty, { force: true });
  });
});

describe("resolveSidecarAuthToken (orchestrator-side allocator bearer token, file-preferred)", () => {
  it("prefers the mounted file over the plaintext env (file WINS)", () => {
    const file = writeSecretFile("file-token\n");
    expect(resolveSidecarAuthToken({ TANREN_ALLOCATOR_TOKEN: "env-token", TANREN_ALLOCATOR_TOKEN_FILE: file })).toBe(
      "file-token",
    );
    rmSync(file, { force: true });
  });

  it("falls back to the plaintext env (dev convenience)", () => {
    expect(resolveSidecarAuthToken({ TANREN_ALLOCATOR_TOKEN: "dev" })).toBe("dev");
  });

  it("fails LOUD on an unreadable file, an empty file, and a missing token", () => {
    expect(() => resolveSidecarAuthToken({ TANREN_ALLOCATOR_TOKEN_FILE: "/no/such/tok" })).toThrow(
      /TANREN_ALLOCATOR_TOKEN_FILE=.*could not be read/u,
    );
    const empty = writeSecretFile("   \n");
    expect(() => resolveSidecarAuthToken({ TANREN_ALLOCATOR_TOKEN_FILE: empty })).toThrow(
      /TANREN_ALLOCATOR_TOKEN_FILE=.*is empty/u,
    );
    rmSync(empty, { force: true });
    expect(() => resolveSidecarAuthToken({})).toThrow(/TANREN_ALLOCATOR_TOKEN is required/u);
  });
});
