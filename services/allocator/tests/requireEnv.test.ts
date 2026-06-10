// The allocator's VAULT_TOKEN is REQUIRED — the `?? "dev-root-token"` fallback was
// removed (managed-hosting dimension D). `requireEnv` fails hard on an unset/blank
// value, mirroring `required(env, ...)` in secretStoreFactory.ts.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEnv, requireSecretEnv } from "../src/requireEnv.js";

/** Write `contents` to a fresh temp file and return its path (a mounted-secret stand-in). */
function writeSecretFile(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tanren-alloc-token-")), "token");
  writeFileSync(file, contents);
  return file;
}

describe("allocator requireEnv (no dev-root-token fallback)", () => {
  const original = process.env["VAULT_TOKEN"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["VAULT_TOKEN"];
    } else {
      process.env["VAULT_TOKEN"] = original;
    }
  });

  it("throws when VAULT_TOKEN is unset (no fallback)", () => {
    delete process.env["VAULT_TOKEN"];
    expect(() => requireEnv("VAULT_TOKEN")).toThrow(/VAULT_TOKEN is required/u);
  });

  it("throws when VAULT_TOKEN is blank", () => {
    process.env["VAULT_TOKEN"] = "";
    expect(() => requireEnv("VAULT_TOKEN")).toThrow(/VAULT_TOKEN is required/u);
  });

  it("returns the value when VAULT_TOKEN is set", () => {
    process.env["VAULT_TOKEN"] = "a-real-token";
    expect(requireEnv("VAULT_TOKEN")).toBe("a-real-token");
  });

  it("never resolves to the old dev-root-token default", () => {
    delete process.env["VAULT_TOKEN"];
    let resolved: string | undefined;
    try {
      resolved = requireEnv("VAULT_TOKEN");
    } catch {
      resolved = undefined;
    }
    expect(resolved).not.toBe("dev-root-token");
  });
});

// The allocator's SYSTEM pool MUST be the BYPASSRLS `tanren_system` role
// (TANREN_SYSTEM_DATABASE_URL), never a silent collapse onto the tenant runtime
// DATABASE_URL — a cross-org sweep/reap on the NOBYPASSRLS app role would see ZERO
// `runners` rows under enforced RLS. main.ts resolves it through `requireEnv`, so
// an unset/blank value fails LOUD (the prior `|| DATABASE_URL` fallback is gone).
describe("allocator system DB URL is required (no silent tenant-pool collapse)", () => {
  const original = process.env["TANREN_SYSTEM_DATABASE_URL"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["TANREN_SYSTEM_DATABASE_URL"];
    } else {
      process.env["TANREN_SYSTEM_DATABASE_URL"] = original;
    }
  });

  it("throws naming the var when TANREN_SYSTEM_DATABASE_URL is unset", () => {
    delete process.env["TANREN_SYSTEM_DATABASE_URL"];
    expect(() => requireEnv("TANREN_SYSTEM_DATABASE_URL")).toThrow(/TANREN_SYSTEM_DATABASE_URL is required/u);
  });

  it("throws when TANREN_SYSTEM_DATABASE_URL is blank", () => {
    process.env["TANREN_SYSTEM_DATABASE_URL"] = "";
    expect(() => requireEnv("TANREN_SYSTEM_DATABASE_URL")).toThrow(/TANREN_SYSTEM_DATABASE_URL is required/u);
  });

  it("returns the BYPASSRLS system URL when set (never the tenant DATABASE_URL)", () => {
    process.env["TANREN_SYSTEM_DATABASE_URL"] = "postgres://tanren_system:pw@db:5432/tanren";
    expect(requireEnv("TANREN_SYSTEM_DATABASE_URL")).toBe("postgres://tanren_system:pw@db:5432/tanren");
  });
});

// Codex r5: the allocator bearer token is FILE-PREFERRED in prod — the compose
// mounts it as /run/secrets/tanren_allocator_token and sets TANREN_ALLOCATOR_TOKEN_FILE
// so the token VALUE never lands in Docker env / `docker inspect`. requireSecretEnv
// reads the mounted FILE in preference to the plaintext env (file WINS), and fails
// LOUD on a missing/empty file — never a silent blank token.
describe("allocator requireSecretEnv (file-preferred bearer token)", () => {
  const original = process.env["TANREN_ALLOCATOR_TOKEN"];
  const originalFile = process.env["TANREN_ALLOCATOR_TOKEN_FILE"];
  afterEach(() => {
    for (const [name, value] of [
      ["TANREN_ALLOCATOR_TOKEN", original],
      ["TANREN_ALLOCATOR_TOKEN_FILE", originalFile],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("reads the mounted file in preference to the plaintext env (file WINS)", () => {
    const file = writeSecretFile("file-token\n");
    process.env["TANREN_ALLOCATOR_TOKEN"] = "env-token";
    process.env["TANREN_ALLOCATOR_TOKEN_FILE"] = file;
    expect(requireSecretEnv("TANREN_ALLOCATOR_TOKEN")).toBe("file-token");
    rmSync(file, { force: true });
  });

  it("falls back to the plaintext env when no file is set (dev convenience)", () => {
    delete process.env["TANREN_ALLOCATOR_TOKEN_FILE"];
    process.env["TANREN_ALLOCATOR_TOKEN"] = "dev";
    expect(requireSecretEnv("TANREN_ALLOCATOR_TOKEN")).toBe("dev");
  });

  it("fails LOUD when the file path is unreadable", () => {
    process.env["TANREN_ALLOCATOR_TOKEN_FILE"] = "/no/such/alloc-token";
    expect(() => requireSecretEnv("TANREN_ALLOCATOR_TOKEN")).toThrow(
      /TANREN_ALLOCATOR_TOKEN_FILE=.*could not be read/u,
    );
  });

  it("fails LOUD when the mounted file is present but empty (never a silent blank token)", () => {
    const file = writeSecretFile("   \n");
    process.env["TANREN_ALLOCATOR_TOKEN_FILE"] = file;
    expect(() => requireSecretEnv("TANREN_ALLOCATOR_TOKEN")).toThrow(/TANREN_ALLOCATOR_TOKEN_FILE=.*is empty/u);
    rmSync(file, { force: true });
  });

  it("fails LOUD when NEITHER the file nor the env is set", () => {
    delete process.env["TANREN_ALLOCATOR_TOKEN_FILE"];
    delete process.env["TANREN_ALLOCATOR_TOKEN"];
    expect(() => requireSecretEnv("TANREN_ALLOCATOR_TOKEN")).toThrow(/TANREN_ALLOCATOR_TOKEN is required/u);
  });
});
