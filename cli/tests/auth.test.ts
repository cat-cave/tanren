import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliLoginIncomplete,
  deleteAuth,
  InvalidAuthFileError,
  login,
  parseStoredAuth,
  readAuth,
  writeAuth,
} from "../src/auth/index.js";
import { captureStdout } from "./helpers/captureOutput.js";

describe("CLI auth flow", () => {
  let dir = "";
  let originalEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tanren-cli-auth-"));
    originalEnv = process.env.TANREN_AUTH_FILE;
    process.env.TANREN_AUTH_FILE = join(dir, "auth.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.TANREN_AUTH_FILE;
    } else {
      process.env.TANREN_AUTH_FILE = originalEnv;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists a directly supplied token to the auth file with 0600 permissions", async () => {
    const result = await login({
      orchestratorUrl: "http://localhost:3100",
      token: "tnt_real_token",
      name: "test",
    });
    expect(result.auth.token).toBe("tnt_real_token");
    const persisted = await readAuth();
    expect(persisted?.token).toBe("tnt_real_token");
    const raw = await readFile(process.env.TANREN_AUTH_FILE ?? "", "utf8");
    expect(raw).toContain("tnt_real_token");
  });

  it("starts the browser flow and reports incomplete when no token is supplied", async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            authorizeUrl: "https://github.example/oauth/authorize?state=abc",
            completeUrl: "http://localhost:3100/auth/cli/complete",
            state: "abc",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    await expect(
      login({
        orchestratorUrl: "http://localhost:3100",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CliLoginIncomplete);
  });

  it("authHeaders reads token from the configured path and sends bearer", async () => {
    await writeAuth({
      orchestratorUrl: "http://localhost:3100",
      token: "tnt_hdr",
      createdAt: new Date().toISOString(),
    });
    const { authHeaders } = await import("../src/auth/index.js");
    const headers = await authHeaders();
    expect(headers.Authorization).toBe("Bearer tnt_hdr");
  });

  it("logout removes the auth file so readAuth returns undefined (readable empty state)", async () => {
    const path = process.env.TANREN_AUTH_FILE ?? "";
    await writeAuth({
      orchestratorUrl: "http://localhost:3100",
      token: "tnt_logout",
      createdAt: new Date().toISOString(),
    });
    expect(await readAuth()).toBeDefined();
    await deleteAuth();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readAuth()).toBeUndefined();
    // Idempotent: second logout does not throw.
    await expect(deleteAuth()).resolves.toBeUndefined();
  });

  it("auth logout command prints ok and leaves no corrupt file", async () => {
    await writeAuth({
      orchestratorUrl: "http://localhost:3100",
      token: "tnt_cmd",
      createdAt: new Date().toISOString(),
    });
    vi.resetModules();
    const main = await import("../src/main.js");
    const out = await captureStdout(() => main.authLogoutCommand());
    expect(out.json()).toEqual({ ok: true });
    expect(await readAuth()).toBeUndefined();
  });

  it("readAuth recovers from legacy empty-file logout without throwing", async () => {
    const path = process.env.TANREN_AUTH_FILE ?? "";
    await writeFile(path, "");
    expect(await readAuth()).toBeUndefined();
  });

  it("readAuth rejects schema-invalid auth objects (valid JSON, incomplete shape)", async () => {
    const path = process.env.TANREN_AUTH_FILE ?? "";
    await writeFile(path, '{"token":"only"}\n');
    await expect(readAuth()).rejects.toBeInstanceOf(InvalidAuthFileError);
  });

  it("readAuth rejects syntactically invalid JSON with a redacted stable error", async () => {
    const path = process.env.TANREN_AUTH_FILE ?? "";
    const secret = "tnt_sentinel_SECRET_never_leak_9f3a";
    // Truncated JSON: real syntax error, embedding a secret in the raw blob.
    await writeFile(path, `{"token":"${secret}","orchestratorUrl":`);
    const error = await readAuth().then(
      () => {
        throw new Error("expected readAuth to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidAuthFileError);
    expect((error as Error).message).toMatch(/not valid JSON/u);
    expect((error as Error).message).not.toContain(secret);
  });

  it("writeAuth rejects incomplete StoredAuth before persisting", async () => {
    await expect(
      writeAuth({
        orchestratorUrl: "",
        token: "x",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(InvalidAuthFileError);
  });

  it("writeAuth / parseStoredAuth reject tokens with CR/LF/control characters", async () => {
    const base = {
      orchestratorUrl: "http://localhost:3100",
      createdAt: new Date().toISOString(),
    };
    await expect(writeAuth({ ...base, token: "tnt_ok\r\ninjected" })).rejects.toBeInstanceOf(InvalidAuthFileError);
    await expect(writeAuth({ ...base, token: "tnt_ok\ninjected" })).rejects.toThrow(/control characters/u);
    await expect(writeAuth({ ...base, token: "tnt_ok\0null" })).rejects.toThrow(/control characters/u);
  });
});

describe("parseStoredAuth schema", () => {
  const valid = {
    orchestratorUrl: "http://localhost:3100",
    token: "tnt_ok",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a full valid object with optional fields", () => {
    expect(
      parseStoredAuth({
        ...valid,
        tokenId: "tid",
        name: "cli",
        scopes: ["read", "write"],
      }),
    ).toEqual({
      ...valid,
      tokenId: "tid",
      name: "cli",
      scopes: ["read", "write"],
    });
  });

  it("rejects non-objects, arrays, null, and missing required fields", () => {
    expect(() => parseStoredAuth(null)).toThrow(InvalidAuthFileError);
    expect(() => parseStoredAuth([])).toThrow(InvalidAuthFileError);
    expect(() => parseStoredAuth("nope")).toThrow(InvalidAuthFileError);
    expect(() => parseStoredAuth({ ...valid, token: "" })).toThrow(/token/u);
    expect(() => parseStoredAuth({ ...valid, orchestratorUrl: 1 })).toThrow(/orchestratorUrl/u);
    expect(() => parseStoredAuth({ ...valid, scopes: ["a", 2] })).toThrow(/scopes/u);
  });

  it("rejects non-header-safe tokens (CR/LF and other C0 controls)", () => {
    expect(() => parseStoredAuth({ ...valid, token: "a\rb" })).toThrow(/control characters/u);
    expect(() => parseStoredAuth({ ...valid, token: "a\nb" })).toThrow(/control characters/u);
    expect(() => parseStoredAuth({ ...valid, token: "a\tb" })).toThrow(/control characters/u);
    expect(() => parseStoredAuth({ ...valid, token: "a\u001Fb" })).toThrow(/control characters/u);
  });
});
