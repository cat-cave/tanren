import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../../services/orchestrator/src/engine/contracts/secretStore.js";
import { DEFAULT_MANAGED_CREDENTIAL_REF } from "../../services/orchestrator/src/engine/config/managedProvider.js";
import {
  LOCAL_FALLBACK_ENV_FILE,
  MANAGED_ROUTER_KEY_ENV,
  MissingSeedSecretError,
  parseAllowlistedEnvFile,
  resolveSeedSecrets,
  SECRET_ENV_FILE_ENV,
  SEED_SECRET_ALLOWLIST,
  seedPlatformCredentials,
} from "./seed-platform-creds.js";

describe("seedPlatformCredentials", () => {
  it("writes the managed-router key to the platform ref from the env var", async () => {
    const store = new InMemorySecretStore();
    const written = await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" });

    expect(written).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-test-123");
  });

  it("is platform-scoped — never writes a tenant-namespaced credential ref", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-test-123" });

    // The platform ref lives under `credential/openrouter/platform/...`, NOT the
    // tenant `credential/<kind>/org/...` shape the operator API derives.
    const refs = await store.list("credential/");
    expect(refs).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    expect(refs.every((ref) => !ref.includes("/org/") && !ref.includes("/me/"))).toBe(true);
  });

  it("is idempotent: re-seeding upserts the same ref with the new value", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-old" });
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "sk-or-new" });

    const refs = await store.list("credential/");
    expect(refs).toStrictEqual([DEFAULT_MANAGED_CREDENTIAL_REF]);
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-new");
  });

  it("FAILS LOUD (typed MissingSeedSecretError) when no source yields a key — no silent skip", async () => {
    const store = new InMemorySecretStore();
    // No local fallback file on disk in the test cwd → parseAllowlistedEnvFile
    // returns {} for the fallback; no exported env; no TANREN_SECRET_ENV_FILE.
    await expect(seedPlatformCredentials(store, {})).rejects.toThrow(MissingSeedSecretError);
  });

  it("FAILS LOUD when the key env var is blank/whitespace, and writes nothing", async () => {
    const store = new InMemorySecretStore();
    await expect(seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "   " })).rejects.toThrow(
      MissingSeedSecretError,
    );
    // Fail-before-write: a blank value must not leave a half-seeded platform ref.
    expect(await store.list("credential/")).toStrictEqual([]);
  });

  it("trims surrounding whitespace from the seeded key", async () => {
    const store = new InMemorySecretStore();
    await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: "  sk-or-padded\n" });
    const stored = await store.get(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(stored?.value).toBe("sk-or-padded");
  });
});

// A tmp workspace holding env-files under our control, so file-precedence tests
// never depend on a real `.env.validation.local` in the repo checkout.
describe("resolveSeedSecrets — portable precedence + allowlist", () => {
  let dir: string;
  let envFilePath: string;
  let localFallbackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-creds-"));
    envFilePath = join(dir, "external.env");
    localFallbackPath = join(dir, LOCAL_FALLBACK_ENV_FILE);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Injectable readFile that reads the local fallback from our tmp dir path
  // instead of cwd, so the test is hermetic.
  const readFile = (path: string, allow: readonly string[]): Record<string, string> => {
    const resolved = path === LOCAL_FALLBACK_ENV_FILE ? localFallbackPath : path;
    return parseAllowlistedEnvFile(resolved, allow);
  };

  it("exported env WINS over env-file WINS over local fallback (all three set)", () => {
    writeFileSync(envFilePath, `${MANAGED_ROUTER_KEY_ENV}=from-env-file\n`);
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets(
      { [MANAGED_ROUTER_KEY_ENV]: "from-exported", [SECRET_ENV_FILE_ENV]: envFilePath },
      SEED_SECRET_ALLOWLIST,
      readFile,
    );
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-exported");
  });

  it("env-file WINS over local fallback when exported env is absent", () => {
    writeFileSync(envFilePath, `${MANAGED_ROUTER_KEY_ENV}=from-env-file\n`);
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets({ [SECRET_ENV_FILE_ENV]: envFilePath }, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-env-file");
  });

  it("falls back to .env.validation.local when neither exported env nor env-file provide the key", () => {
    writeFileSync(localFallbackPath, `${MANAGED_ROUTER_KEY_ENV}=from-local\n`);
    const resolved = resolveSeedSecrets({}, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-local");
  });

  it("ALLOWLIST: an env-file with an extra non-allowlisted key never loads that key", () => {
    writeFileSync(
      envFilePath,
      [
        `${MANAGED_ROUTER_KEY_ENV}=from-env-file`,
        "AWS_SECRET_ACCESS_KEY=should-never-load",
        "DATABASE_URL=postgres://should-never-load",
      ].join("\n"),
    );
    const resolved = resolveSeedSecrets({ [SECRET_ENV_FILE_ENV]: envFilePath }, SEED_SECRET_ALLOWLIST, readFile);
    expect(resolved[MANAGED_ROUTER_KEY_ENV]).toBe("from-env-file");
    expect(resolved).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(resolved).not.toHaveProperty("DATABASE_URL");
    // Only the allowlisted key ever appears in the resolved map.
    expect(Object.keys(resolved)).toStrictEqual([MANAGED_ROUTER_KEY_ENV]);
  });

  it("MissingSeedSecretError names all three sources when everything is empty", () => {
    // No files, no exported env, TANREN_SECRET_ENV_FILE points at a missing file.
    const missingPath = join(dir, "does-not-exist.env");
    const err = new MissingSeedSecretError(MANAGED_ROUTER_KEY_ENV, missingPath);
    expect(err.message).toContain(`exported env ($${MANAGED_ROUTER_KEY_ENV})`);
    expect(err.message).toContain(`$${SECRET_ENV_FILE_ENV}=${missingPath}`);
    expect(err.message).toContain(LOCAL_FALLBACK_ENV_FILE);
  });
});

describe("parseAllowlistedEnvFile — defensive dotenv parsing", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-parse-"));
    file = join(dir, "some.env");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("handles comments, blank lines, quotes, and `export ` prefixes; ignores unknown keys", () => {
    writeFileSync(
      file,
      [
        "# a comment",
        "",
        `${MANAGED_ROUTER_KEY_ENV}="sk-or-double-quoted"`,
        "IGNORED_KEY=nope",
        "   # indented comment",
      ].join("\n"),
    );
    const parsed = parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV]);
    expect(parsed).toStrictEqual({ [MANAGED_ROUTER_KEY_ENV]: "sk-or-double-quoted" });
  });

  it("strips single quotes and honors an `export KEY=` form", () => {
    writeFileSync(file, `export ${MANAGED_ROUTER_KEY_ENV}='sk-or-single'\n`);
    const parsed = parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV]);
    expect(parsed[MANAGED_ROUTER_KEY_ENV]).toBe("sk-or-single");
  });

  it("returns {} for a missing file (no throw)", () => {
    expect(parseAllowlistedEnvFile(join(dir, "absent.env"), [MANAGED_ROUTER_KEY_ENV])).toStrictEqual({});
  });

  it("treats a blank value as unset (not an empty-string key)", () => {
    writeFileSync(file, `${MANAGED_ROUTER_KEY_ENV}=\n`);
    expect(parseAllowlistedEnvFile(file, [MANAGED_ROUTER_KEY_ENV])).toStrictEqual({});
  });
});

describe("seed logging — never prints the raw key", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-log-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs only the ref + a redacted notice — the raw key value never appears in stdout/stderr", async () => {
    const store = new InMemorySecretStore();
    const rawKey = "sk-or-super-secret-value-do-not-log";
    const written = await seedPlatformCredentials(store, { [MANAGED_ROUTER_KEY_ENV]: rawKey });

    // Simulate the script's reporting loop (main() logs only refs).
    for (const ref of written) {
      console.log(`seed-platform-creds: seeded platform ref ${ref}`);
    }
    console.log(`seed-platform-creds: done (${written.length} platform ref(s))`);

    const allOutput = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()]
      .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
      .join("\n");

    expect(allOutput).not.toContain(rawKey);
    expect(allOutput).toContain(`seeded platform ref ${DEFAULT_MANAGED_CREDENTIAL_REF}`);
  });
});
