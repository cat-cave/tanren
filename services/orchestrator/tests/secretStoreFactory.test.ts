import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AwsSecretsManagerStore,
  awsSecretNameFromRef,
  buildSecretStore,
  buildVaultTokenMinter,
  GcpSecretManagerStore,
  gcpSecretIdFromRef,
  InMemorySecretStore,
  OnePasswordStore,
  onePasswordTitleFromRef,
  resolveVaultMountConfig,
  VaultSecretStore,
} from "../src/engine/contracts/index.js";
import { VaultRunTokenMinter } from "../src/engine/contracts/vaultTokenMinterImpl.js";

const agnosticRef = "credential/github_token/org/acme/default";

/** Write `contents` to a fresh temp file and return its path (a mounted-secret stand-in). */
function writeTokenFile(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tanren-vault-token-")), "token");
  writeFileSync(file, contents);
  return file;
}

// The factory does not inject a transport, so the stores it builds fall back to
// the global `fetch`. Stubbing it lets the tests observe the resolved config
// (addr/mount/region/endpoint/prefix/session-token/field-label) on the wire —
// a real observable outcome of the env-driven construction, not a spy-only
// assertion. Each call records the request and returns a benign response.
function stubFetch(): { calls: { url: string; body: string; headers: Headers }[] } {
  const calls: { url: string; body: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
    });
    // 404 keeps the 1Password lookup short and Vault get undefined; the
    // AWS not-found marker keeps AwsSecretsManagerStore.get resolving undefined.
    return new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 404 });
  }) as typeof fetch);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildSecretStore selector", () => {
  it("requires TANREN_SECRET_STORE — an unset backend throws (no silent default)", () => {
    expect(() => buildSecretStore({})).toThrow(/TANREN_SECRET_STORE/u);
  });

  const vaultEnv = { VAULT_ADDR: "http://vault.internal:8200", VAULT_TOKEN: "live-token" };

  it("selects each backend by TANREN_SECRET_STORE", () => {
    expect(buildSecretStore({ TANREN_SECRET_STORE: "memory" })).toBeInstanceOf(InMemorySecretStore);
    expect(buildSecretStore({ TANREN_SECRET_STORE: "vault", ...vaultEnv })).toBeInstanceOf(VaultSecretStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "gcp_sm",
        TANREN_GCP_SM_PROJECT: "p",
        TANREN_GCP_SM_ACCESS_TOKEN: "t",
      }),
    ).toBeInstanceOf(GcpSecretManagerStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "aws_sm",
        TANREN_AWS_SM_ACCESS_KEY_ID: "k",
        TANREN_AWS_SM_SECRET_ACCESS_KEY: "s",
        TANREN_AWS_SM_REGION: "us-east-1",
      }),
    ).toBeInstanceOf(AwsSecretsManagerStore);
    expect(
      buildSecretStore({
        TANREN_SECRET_STORE: "onepassword",
        TANREN_OP_CONNECT_URL: "https://connect.example.com",
        TANREN_OP_CONNECT_TOKEN: "t",
        TANREN_OP_VAULT_ID: "v",
      }),
    ).toBeInstanceOf(OnePasswordStore);
  });

  it("throws a helpful error for an unknown backend", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "bogus" })).toThrow(/unknown TANREN_SECRET_STORE/u);
  });

  it("throws when a selected backend is missing required credentials", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "gcp_sm" })).toThrow(/TANREN_GCP_SM_PROJECT/u);
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "aws_sm" })).toThrow(/TANREN_AWS_SM_/u);
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "onepassword" })).toThrow(/TANREN_OP_/u);
  });
});

describe("buildVaultTokenMinter (per-run scoped credentials, dimension D)", () => {
  it("builds a VaultRunTokenMinter only for the Vault backend, from the REQUIRED broad token", () => {
    const minter = buildVaultTokenMinter({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "broad-live-token",
    });
    expect(minter).toBeInstanceOf(VaultRunTokenMinter);
  });

  it("returns undefined for every non-Vault backend (no broad Vault token to de-privilege)", () => {
    expect(buildVaultTokenMinter({ TANREN_SECRET_STORE: "memory" })).toBeUndefined();
    expect(
      buildVaultTokenMinter({
        TANREN_SECRET_STORE: "gcp_sm",
        TANREN_GCP_SM_PROJECT: "p",
        TANREN_GCP_SM_ACCESS_TOKEN: "t",
      }),
    ).toBeUndefined();
  });

  it("requires VAULT_ADDR + VAULT_TOKEN for the Vault minter (no dev-root-token fallback)", () => {
    expect(() => buildVaultTokenMinter({ TANREN_SECRET_STORE: "vault" })).toThrow(/VAULT_ADDR/u);
    expect(() => buildVaultTokenMinter({ TANREN_SECRET_STORE: "vault", VAULT_ADDR: "http://vault:8200" })).toThrow(
      /VAULT_TOKEN/u,
    );
  });

  it("resolveVaultMountConfig requires VAULT_ADDR and honours the optional mount", () => {
    expect(resolveVaultMountConfig({ VAULT_ADDR: "http://v:8200" })).toEqual({ addr: "http://v:8200" });
    expect(resolveVaultMountConfig({ VAULT_ADDR: "http://v:8200", VAULT_KV_MOUNT: "kv" })).toEqual({
      addr: "http://v:8200",
      mount: "kv",
    });
    expect(() => resolveVaultMountConfig({})).toThrow(/VAULT_ADDR/u);
  });
});

describe("VAULT_TOKEN_FILE — the broad token from a MOUNTED SECRET FILE (never plaintext env)", () => {
  it("resolves the Vault token from VAULT_TOKEN_FILE with NO VAULT_TOKEN env value present", async () => {
    const { calls } = stubFetch();
    const file = writeTokenFile("file-broad-token\n");
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN_FILE: file,
    });
    await store.get("credential/token");
    // The token read from the mounted file is what reaches Vault (trimmed) — a
    // real observable outcome, with no VAULT_TOKEN env value force-exported.
    expect(calls[0]!.headers.get("X-Vault-Token")).toBe("file-broad-token");
    rmSync(file, { force: true });
  });

  it("VAULT_TOKEN_FILE WINS over a VAULT_TOKEN env value (file path is preferred in prod)", async () => {
    const { calls } = stubFetch();
    const file = writeTokenFile("file-wins-token");
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "env-dev-token",
      VAULT_TOKEN_FILE: file,
    });
    await store.get("credential/token");
    expect(calls[0]!.headers.get("X-Vault-Token")).toBe("file-wins-token");
    rmSync(file, { force: true });
  });

  it("falls back to the VAULT_TOKEN env value when no file path is set (dev convenience)", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "env-dev-token",
    });
    await store.get("credential/token");
    expect(calls[0]!.headers.get("X-Vault-Token")).toBe("env-dev-token");
  });

  it("fails LOUD when NEITHER VAULT_TOKEN_FILE nor VAULT_TOKEN is present", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "vault", VAULT_ADDR: "http://v:8200" })).toThrow(
      /VAULT_TOKEN/u,
    );
  });

  it("fails LOUD when VAULT_TOKEN_FILE points at a missing file", () => {
    expect(() =>
      buildSecretStore({
        TANREN_SECRET_STORE: "vault",
        VAULT_ADDR: "http://v:8200",
        VAULT_TOKEN_FILE: "/no/such/tanren-vault-token",
      }),
    ).toThrow(/VAULT_TOKEN_FILE=.*could not be read/u);
  });

  it("fails LOUD when VAULT_TOKEN_FILE is present but empty (never a silent blank token)", () => {
    const file = writeTokenFile("   \n");
    expect(() =>
      buildSecretStore({ TANREN_SECRET_STORE: "vault", VAULT_ADDR: "http://v:8200", VAULT_TOKEN_FILE: file }),
    ).toThrow(/VAULT_TOKEN_FILE=.*is empty/u);
    rmSync(file, { force: true });
  });

  it("the minter also resolves the broad token from VAULT_TOKEN_FILE", () => {
    const file = writeTokenFile("file-broad-token");
    expect(
      buildVaultTokenMinter({
        TANREN_SECRET_STORE: "vault",
        VAULT_ADDR: "http://vault.internal:8200",
        VAULT_TOKEN_FILE: file,
      }),
    ).toBeInstanceOf(VaultRunTokenMinter);
    rmSync(file, { force: true });
  });
});

describe("alternate-store root credentials from a MOUNTED SECRET FILE (Codex r4 §3)", () => {
  // Each alternate backend's root credential must resolve from a `*_FILE` mounted
  // path (file-preferred precedence, same as VAULT_TOKEN_FILE) so a production root
  // credential need NOT be a plaintext env value. The store CONSTRUCTS (no boot
  // throw) when only the file is set — proof the credential resolved from the file.

  it("gcp_sm resolves its access token from TANREN_GCP_SM_ACCESS_TOKEN_FILE (no env value)", () => {
    const file = writeTokenFile("gcp-file-token\n");
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "gcp_sm",
      TANREN_GCP_SM_PROJECT: "p",
      TANREN_GCP_SM_ACCESS_TOKEN_FILE: file,
    });
    expect(store).toBeInstanceOf(GcpSecretManagerStore);
    rmSync(file, { force: true });
  });

  it("aws_sm resolves its secret access key from TANREN_AWS_SM_SECRET_ACCESS_KEY_FILE (no env value)", () => {
    const file = writeTokenFile("aws-file-secret");
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "aws_sm",
      TANREN_AWS_SM_ACCESS_KEY_ID: "AKIA",
      TANREN_AWS_SM_SECRET_ACCESS_KEY_FILE: file,
      TANREN_AWS_SM_REGION: "us-east-1",
    });
    expect(store).toBeInstanceOf(AwsSecretsManagerStore);
    rmSync(file, { force: true });
  });

  it("onepassword resolves its connect token from TANREN_OP_CONNECT_TOKEN_FILE (no env value)", () => {
    const file = writeTokenFile("op-file-token");
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "onepassword",
      TANREN_OP_CONNECT_URL: "https://connect.example.com",
      TANREN_OP_CONNECT_TOKEN_FILE: file,
      TANREN_OP_VAULT_ID: "v1",
    });
    expect(store).toBeInstanceOf(OnePasswordStore);
    rmSync(file, { force: true });
  });

  it("the file path WINS over the plaintext env value (prod precedence)", () => {
    const file = writeTokenFile("gcp-file-token");
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "gcp_sm",
      TANREN_GCP_SM_PROJECT: "my-proj",
      TANREN_GCP_SM_ACCESS_TOKEN: "env-token",
      TANREN_GCP_SM_ACCESS_TOKEN_FILE: file,
    });
    return store.get("credential/token").then(() => {
      // The bearer that reaches the GCP SM API is the file token, not the env one.
      expect(calls[0]!.headers.get("authorization")).toBe("Bearer gcp-file-token");
      rmSync(file, { force: true });
    });
  });

  it("fails LOUD when a configured store has NEITHER the file nor the env credential", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "gcp_sm", TANREN_GCP_SM_PROJECT: "p" })).toThrow(
      /TANREN_GCP_SM_ACCESS_TOKEN/u,
    );
  });

  it("fails LOUD when the *_FILE points at a missing file", () => {
    expect(() =>
      buildSecretStore({
        TANREN_SECRET_STORE: "onepassword",
        TANREN_OP_CONNECT_URL: "https://connect.example.com",
        TANREN_OP_CONNECT_TOKEN_FILE: "/no/such/op-token",
        TANREN_OP_VAULT_ID: "v1",
      }),
    ).toThrow(/TANREN_OP_CONNECT_TOKEN_FILE=.*could not be read/u);
  });

  it("fails LOUD when the *_FILE is present but empty (never a silent blank credential)", () => {
    const file = writeTokenFile("   \n");
    expect(() =>
      buildSecretStore({
        TANREN_SECRET_STORE: "aws_sm",
        TANREN_AWS_SM_ACCESS_KEY_ID: "AKIA",
        TANREN_AWS_SM_SECRET_ACCESS_KEY_FILE: file,
        TANREN_AWS_SM_REGION: "us-east-1",
      }),
    ).toThrow(/TANREN_AWS_SM_SECRET_ACCESS_KEY_FILE=.*is empty/u);
    rmSync(file, { force: true });
  });
});

describe("ref -> backend key mapping", () => {
  it("GCP sanitizes the ref into a valid Secret Manager id", () => {
    expect(gcpSecretIdFromRef(agnosticRef)).toBe("credential_github_token_org_acme_default");
    // Deterministic + total within the id charset.
    expect(gcpSecretIdFromRef(agnosticRef)).toBe(gcpSecretIdFromRef(agnosticRef));
    expect(gcpSecretIdFromRef("")).toBe("_");
  });

  it("AWS uses the ref verbatim, optionally prefixed", () => {
    expect(awsSecretNameFromRef(agnosticRef)).toBe(agnosticRef);
    expect(awsSecretNameFromRef(agnosticRef, "tanren")).toBe(`tanren/${agnosticRef}`);
  });

  it("1Password uses the ref as the item title", () => {
    expect(onePasswordTitleFromRef(agnosticRef)).toBe(agnosticRef);
  });
});

describe("buildSecretStore env-driven config resolution", () => {
  it("treats an empty-string required credential as missing", () => {
    expect(() =>
      buildSecretStore({ TANREN_SECRET_STORE: "gcp_sm", TANREN_GCP_SM_PROJECT: "", TANREN_GCP_SM_ACCESS_TOKEN: "t" }),
    ).toThrow(/TANREN_GCP_SM_PROJECT/u);
  });

  it("requires Vault addr and token (no localhost:8200 / dev-root-token fallback)", () => {
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "vault" })).toThrow(/VAULT_ADDR/u);
    expect(() => buildSecretStore({ TANREN_SECRET_STORE: "vault", VAULT_ADDR: "http://vault:8200" })).toThrow(
      /VAULT_TOKEN/u,
    );
  });

  it("defaults the Vault KV mount when the env omits it (addr/token still required)", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "live-token",
    });
    await store.get("credential/token");
    // Default mount (secret); explicit addr + token header.
    expect(calls[0]!.url).toBe("http://vault.internal:8200/v1/secret/data/credential/token");
    expect(calls[0]!.headers.get("X-Vault-Token")).toBe("live-token");
  });

  it("honours explicit Vault addr/token/mount from the env", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "live-token",
      VAULT_KV_MOUNT: "kv-prod",
    });
    await store.get("credential/token");
    expect(calls[0]!.url).toBe("http://vault.internal:8200/v1/kv-prod/data/credential/token");
    expect(calls[0]!.headers.get("X-Vault-Token")).toBe("live-token");
  });

  it("treats an empty VAULT_KV_MOUNT as unset (default mount)", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "live-token",
      VAULT_KV_MOUNT: "",
    });
    await store.get("credential/token");
    expect(calls[0]!.url).toContain("/v1/secret/data/");
  });

  it("resolves the GCP project and apiBase override into the request url", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "gcp_sm",
      TANREN_GCP_SM_PROJECT: "my-proj",
      TANREN_GCP_SM_ACCESS_TOKEN: "tok",
      TANREN_GCP_SM_API_BASE: "https://gcp.stub/v1",
    });
    await store.get("credential/token");
    expect(calls[0]!.url).toBe("https://gcp.stub/v1/projects/my-proj/secrets/credential_token/versions/latest:access");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("resolves the AWS region, endpoint, session token and name prefix", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "aws_sm",
      TANREN_AWS_SM_ACCESS_KEY_ID: "AKIA",
      TANREN_AWS_SM_SECRET_ACCESS_KEY: "sk",
      TANREN_AWS_SM_REGION: "ap-south-1",
      TANREN_AWS_SM_SESSION_TOKEN: "sess",
      TANREN_AWS_SM_NAME_PREFIX: "tanren",
      TANREN_AWS_SM_ENDPOINT: "http://localstack:4566/",
    });
    await store.get("credential/token");
    // Endpoint override (trailing slash normalized), session token header, prefixed name.
    expect(calls[0]!.url).toBe("http://localstack:4566/");
    expect(calls[0]!.headers.get("x-amz-security-token")).toBe("sess");
    expect(JSON.parse(calls[0]!.body)).toEqual({ SecretId: "tanren/credential/token" });
    // Region appears in the SigV4 credential scope.
    expect(calls[0]!.headers.get("authorization")).toContain("/ap-south-1/secretsmanager/aws4_request");
  });

  it("defaults the AWS endpoint to the region host when no endpoint is configured", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "aws_sm",
      TANREN_AWS_SM_ACCESS_KEY_ID: "AKIA",
      TANREN_AWS_SM_SECRET_ACCESS_KEY: "sk",
      TANREN_AWS_SM_REGION: "eu-central-1",
    });
    await store.get("credential/token");
    expect(calls[0]!.url).toBe("https://secretsmanager.eu-central-1.amazonaws.com/");
    expect(calls[0]!.headers.get("x-amz-security-token")).toBeNull();
    expect(JSON.parse(calls[0]!.body)).toEqual({ SecretId: "credential/token" });
  });

  it("resolves the 1Password connect url, vault id and field label", async () => {
    const { calls } = stubFetch();
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "onepassword",
      TANREN_OP_CONNECT_URL: "https://op.internal",
      TANREN_OP_CONNECT_TOKEN: "op-tok",
      TANREN_OP_VAULT_ID: "vault-123",
      TANREN_OP_FIELD_LABEL: "api_key",
    });
    // 404 on the lookup -> get resolves undefined.
    await expect(store.get("credential/token")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(
      `https://op.internal/v1/vaults/vault-123/items?filter=${encodeURIComponent('title eq "credential/token"')}`,
    );
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer op-tok");
  });

  it("passes a configured 1Password field label through to the stored item", async () => {
    // A tailored stub: empty lookup (200 []) then capture the create-item body so
    // the resolved field label is observable on the wire.
    const bodies: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET") === "GET" && url.includes("?filter=")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ id: "item-1" }), { status: 200 });
    }) as typeof fetch);
    const store = buildSecretStore({
      TANREN_SECRET_STORE: "onepassword",
      TANREN_OP_CONNECT_URL: "https://op.internal",
      TANREN_OP_CONNECT_TOKEN: "op-tok",
      TANREN_OP_VAULT_ID: "vault-123",
      TANREN_OP_FIELD_LABEL: "api_key",
    });
    await store.put({ ref: "credential/token", value: "v" });
    const created = JSON.parse(bodies[0]!) as { fields: { label: string }[] };
    expect(created.fields[0]!.label).toBe("api_key");
  });
});
