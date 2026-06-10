import { readFileSync } from "node:fs";
import { InMemorySecretStore, type SecretStore, VaultSecretStore } from "./secretStore.js";
import { GcpSecretManagerStore } from "./gcpSecretManager.js";
import { AwsSecretsManagerStore } from "./awsSecretsManager.js";
import { OnePasswordStore } from "./onePassword.js";
import { VaultRunTokenMinter } from "./vaultTokenMinterImpl.js";
import type { VaultTokenMinter } from "./vaultTokenMinter.js";

/** Selectable SecretStore backends. There is NO default — `TANREN_SECRET_STORE`
 * must name one explicitly (the compose stacks set `vault`). `memory` is the
 * in-process test/dev backend; production must point at a real secret store. */
export type SecretStoreKind = "vault" | "gcp_sm" | "aws_sm" | "onepassword" | "memory";

/** Process-environment view; defaults to `process.env`, injectable in tests. */
export type SecretStoreEnv = Record<string, string | undefined>;

function required(env: SecretStoreEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`secret store backend requires ${name}`);
  }
  return value;
}

function optional(env: SecretStoreEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolve the BROAD Vault token, preferring a MOUNTED SECRET FILE over a plaintext
 * env value. Precedence — a file path WINS:
 *
 *   1. `VAULT_TOKEN_FILE` (preferred, prod): read the token from the file at boot,
 *      in-memory, and never force the broad token into the process env (so it stays
 *      out of `/proc/<pid>/environ` and is not inherited by child processes — incl.
 *      the runner SSH subprocess). Mirrors the SSH runner-identity key's
 *      mounted-secret-file delivery (`TANREN_RUNNER_IDENTITY_KEY_PATH`).
 *   2. `VAULT_TOKEN` (dev convenience): a plaintext env value, for the single-process
 *      dev/smoke path only.
 *
 * Fail-loud when neither resolves to a non-blank token (a configured-but-empty file
 * is itself a hard failure — never a silent blank token on this security boundary).
 *
 * Exported so the orchestrator's Vault HEALTH probe (main.ts) resolves the broad
 * token through the SAME file-preferred precedence — it must not assume a plaintext
 * `VAULT_TOKEN` env value the prod profile no longer sets.
 */
export function requireVaultToken(env: SecretStoreEnv = process.env): string {
  const file = optional(env, "VAULT_TOKEN_FILE");
  if (file !== undefined) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch (cause) {
      throw new Error(`VAULT_TOKEN_FILE=${file} could not be read`, { cause });
    }
    const token = contents.trim();
    if (token === "") {
      throw new Error(`VAULT_TOKEN_FILE=${file} is empty (no Vault token in the mounted secret file)`);
    }
    return token;
  }
  return required(env, "VAULT_TOKEN");
}

/**
 * Selects and constructs the SecretStore backend named REQUIRED by
 * `TANREN_SECRET_STORE` (no default — an unset/blank value throws). Each backend
 * reads its own resolved credentials from the environment, all REQUIRED (no
 * `localhost:8200` / `dev-root-token` fallbacks). This is the single
 * construction point replacing direct `new VaultSecretStore(...)` calls, so the
 * whole app (HTTP server, run worker, allocators) uses the selected backend.
 * Per-backend ref→key mapping is documented on each impl.
 */
export function buildSecretStore(env: SecretStoreEnv = process.env): SecretStore {
  const kind = required(env, "TANREN_SECRET_STORE").toLowerCase() as SecretStoreKind;
  switch (kind) {
    case "memory":
      return new InMemorySecretStore();
    case "vault":
      return new VaultSecretStore({
        addr: required(env, "VAULT_ADDR"),
        token: requireVaultToken(env),
        ...(optional(env, "VAULT_KV_MOUNT") === undefined ? {} : { mount: required(env, "VAULT_KV_MOUNT") }),
      });
    case "gcp_sm":
      return new GcpSecretManagerStore({
        project: required(env, "TANREN_GCP_SM_PROJECT"),
        accessToken: required(env, "TANREN_GCP_SM_ACCESS_TOKEN"),
        ...(optional(env, "TANREN_GCP_SM_API_BASE") === undefined
          ? {}
          : { apiBase: required(env, "TANREN_GCP_SM_API_BASE") }),
      });
    case "aws_sm":
      return new AwsSecretsManagerStore({
        accessKeyId: required(env, "TANREN_AWS_SM_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "TANREN_AWS_SM_SECRET_ACCESS_KEY"),
        region: required(env, "TANREN_AWS_SM_REGION"),
        ...(optional(env, "TANREN_AWS_SM_SESSION_TOKEN") === undefined
          ? {}
          : { sessionToken: required(env, "TANREN_AWS_SM_SESSION_TOKEN") }),
        ...(optional(env, "TANREN_AWS_SM_NAME_PREFIX") === undefined
          ? {}
          : { namePrefix: required(env, "TANREN_AWS_SM_NAME_PREFIX") }),
        ...(optional(env, "TANREN_AWS_SM_ENDPOINT") === undefined
          ? {}
          : { endpoint: required(env, "TANREN_AWS_SM_ENDPOINT") }),
      });
    case "onepassword":
      return new OnePasswordStore({
        connectUrl: required(env, "TANREN_OP_CONNECT_URL"),
        token: required(env, "TANREN_OP_CONNECT_TOKEN"),
        vaultId: required(env, "TANREN_OP_VAULT_ID"),
        ...(optional(env, "TANREN_OP_FIELD_LABEL") === undefined
          ? {}
          : { fieldLabel: required(env, "TANREN_OP_FIELD_LABEL") }),
      });
    default:
      throw new Error(`unknown TANREN_SECRET_STORE='${kind}' (expected vault|gcp_sm|aws_sm|onepassword|memory)`);
  }
}

/**
 * The Vault address + KV mount the run-token minter (and the scoped
 * `VaultSecretStore` it builds) operate against. Resolved from the SAME REQUIRED
 * env as the Vault SecretStore backend — `VAULT_ADDR` is required (no
 * `localhost:8200` fallback), `VAULT_KV_MOUNT` optional (defaults to `secret`).
 */
export interface VaultMountConfig {
  addr: string;
  mount?: string;
  /**
   * Test seam: the `fetch` the scoped `VaultSecretStore` reads through. Omitted in
   * production (global `fetch` against the real Vault); a test points the scoped
   * store at the SAME recording transport its minter uses so the de-privilege is
   * provable against a fake Vault.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Build the per-run scoped-credential minter when (and only when) the configured
 * secret store is Vault. Returns `undefined` for every other backend — those
 * backends do NOT have a Vault broad token to de-privilege, so the run path keeps
 * using their (already-tenant-namespaced) store directly. This is not a stub: a
 * non-Vault backend genuinely has no Vault child-token to mint. The minter is
 * constructed from the BROAD Vault token (resolved by {@link requireVaultToken} —
 * the mounted `VAULT_TOKEN_FILE` in prod, the `VAULT_TOKEN` env in dev — the same
 * token the SecretStore uses) and is used ONLY to mint short-lived per-run children;
 * the broad token is never handed to a runner.
 */
export function buildVaultTokenMinter(env: SecretStoreEnv = process.env): VaultTokenMinter | undefined {
  const kind = required(env, "TANREN_SECRET_STORE").toLowerCase() as SecretStoreKind;
  if (kind !== "vault") {
    return undefined;
  }
  const { addr, mount } = resolveVaultMountConfig(env);
  return new VaultRunTokenMinter({
    addr,
    token: requireVaultToken(env),
    ...(mount === undefined ? {} : { mount }),
  });
}

/** Resolve the Vault address + optional KV mount from the REQUIRED env. */
export function resolveVaultMountConfig(env: SecretStoreEnv = process.env): VaultMountConfig {
  const mount = optional(env, "VAULT_KV_MOUNT");
  return { addr: required(env, "VAULT_ADDR"), ...(mount === undefined ? {} : { mount }) };
}
