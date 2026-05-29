import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliLoginIncomplete, login, readAuth, writeAuth } from "../src/auth/index.js";

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
});
