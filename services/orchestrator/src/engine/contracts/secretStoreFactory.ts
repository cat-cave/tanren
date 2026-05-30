import { InMemorySecretStore, type SecretStore, VaultSecretStore } from "./secretStore.js";
import { GcpSecretManagerStore } from "./gcpSecretManager.js";
import { AwsSecretsManagerStore } from "./awsSecretsManager.js";
import { OnePasswordStore } from "./onePassword.js";

/** Selectable SecretStore backends. `vault` is the default for back-compat. */
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
 * Selects and constructs the SecretStore backend named by
 * `TANREN_SECRET_STORE` (default `vault`, so nothing changes unless configured).
 * Each backend reads its own resolved credentials from the environment. This is
 * the single construction point replacing direct `new VaultSecretStore(...)`
 * calls, so the whole app (HTTP server, run worker, allocators) uses the
 * selected backend. Per-backend ref→key mapping is documented on each impl.
 */
export function buildSecretStore(env: SecretStoreEnv = process.env): SecretStore {
  const kind = (env["TANREN_SECRET_STORE"] ?? "vault").toLowerCase() as SecretStoreKind;
  switch (kind) {
    case "memory":
      return new InMemorySecretStore();
    case "vault":
      return new VaultSecretStore({
        addr: env["VAULT_ADDR"] ?? "http://localhost:8200",
        token: env["VAULT_TOKEN"] ?? "dev-root-token",
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
