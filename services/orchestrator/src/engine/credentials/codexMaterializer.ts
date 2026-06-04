import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateCodexAuthBundle, validateCodexCredentialRef, validateCredentialRef } from "./codexAuth.js";
import { resolveManagedOpenRouterKey } from "./managedKey.js";

export interface MaterializeCodexAuthInput {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  runId: string;
  baseDir?: string;
  timeoutMs?: number;
  // SaaS Tier-B #5: MANAGED mode. When true, the run resolved the platform
  // OpenRouter shell and `ref` is a plain API-KEY credential
  // (credential/openrouter/…) whose stored secret is the raw key string `sk-…`,
  // NOT a Codex ChatGPT auth-bundle JSON. In that mode we MUST NOT run the
  // codex-ref / codex-bundle validators (the ref is not credential/codex/ and the
  // value is not a token bundle). Instead, per OpenRouter's Codex-CLI cookbook,
  // we write a `config.toml` declaring `[model_providers.openrouter]` +
  // `model_provider = "openrouter"` and place the key under `OPENROUTER_API_KEY`
  // (config's `env_key`) in a per-run env file the command sources — so codex
  // routes THROUGH OpenRouter. Absent/false ⇒ BYOK: the unchanged codex-bundle
  // path (auth.json + the CLI's native endpoint).
  managed?: boolean;
  // The managed OpenRouter base URL the cookbook's `[model_providers.openrouter]`
  // block points `base_url` at (e.g. `https://openrouter.ai/api/v1`). Required
  // (and only consulted) when `managed` is true.
  endpointBaseUrl?: string;
}

export interface MaterializedCodexAuth {
  CODEX_HOME: string;
  ref: string;
  // Whether this run is managed (OpenRouter via config.toml). The command
  // builder reads this to source the per-run OPENROUTER_API_KEY env file and to
  // honor the CODEX_HOME config.toml instead of passing `--ignore-user-config`.
  managed: boolean;
  redacted: true;
}

export async function materializeCodexAuthBundle(input: MaterializeCodexAuthInput): Promise<MaterializedCodexAuth> {
  const codexHome = codexHomeForRun(input.runId, input.baseDir);
  if (input.managed === true) {
    await materializeManagedCodexConfig(input, codexHome);
    return { CODEX_HOME: codexHome, ref: validateCredentialRef(input.ref), managed: true, redacted: true };
  }
  // BYOK (default, unchanged): validate the codex/ ref + the ChatGPT token bundle
  // and write codex's auth.json.
  const { ref, authJson } = await resolveCodexBundleAuthJson(input.secrets, input.ref);
  const command = buildCodexAuthMaterializationCommand(codexHome);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
  return { CODEX_HOME: codexHome, ref, managed: false, redacted: true };
}

/**
 * MANAGED materialization (OpenRouter via the Codex-CLI cookbook). Writes two
 * files into the per-run CODEX_HOME:
 *   - `config.toml` — `model_provider = "openrouter"` plus the
 *     `[model_providers.openrouter]` block (`base_url`, `env_key`), so `codex
 *     exec` (run with this CODEX_HOME, NOT `--ignore-user-config`) routes through
 *     OpenRouter;
 *   - a key env file (chmod 600) exporting `OPENROUTER_API_KEY=<key>` — the
 *     secret VALUE lives only in this file, never in the command string/events.
 * The command builder sources the env file before `codex exec`.
 */
async function materializeManagedCodexConfig(input: MaterializeCodexAuthInput, codexHome: string): Promise<void> {
  if (input.endpointBaseUrl === undefined || input.endpointBaseUrl.trim() === "") {
    // No silent fallback: a managed codex run with no endpoint is a wiring bug.
    throw new Error("managed Codex run requires an endpoint base URL for the OpenRouter provider block");
  }
  const apiKey = await resolveManagedOpenRouterKey(input.secrets, input.ref);
  const result = await input.ssh.run(input.target, {
    command: buildManagedCodexMaterializationCommand(codexHome, input.endpointBaseUrl),
    // The secret key is fed on stdin and the command writes it into the chmod-600
    // env file — it is never interpolated into the command string.
    stdin: `export OPENROUTER_API_KEY=${shellSingleQuote(apiKey)}\n`,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
}

function assertMaterializationOk(result: {
  failure?: { message?: string; reason?: string };
  exitCode: number | null;
}): void {
  if (result.failure !== undefined) {
    throw new Error(`Codex credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Codex credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
}

function failureMessage(failure: { message?: string; reason?: string }): string {
  return failure.message ?? failure.reason ?? "unknown failure";
}

/**
 * BYOK resolution (unchanged): the ref must be a `credential/codex/` ref and the
 * stored secret must be a Codex ChatGPT auth-bundle JSON. Returns the validated
 * ref + the canonicalized bundle JSON to materialize into `auth.json`.
 */
async function resolveCodexBundleAuthJson(
  secrets: SecretStore,
  rawRef: string,
): Promise<{ ref: string; authJson: string }> {
  const ref = validateCodexCredentialRef(rawRef);
  const secret = await secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing Codex credential ref: ${ref}`);
  }
  const bundle = validateCodexAuthBundle(secret.value);
  return { ref, authJson: bundle.authJson };
}

export function codexHomeForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/u, "")}/${runId}/codex-home`;
}

export function buildCodexAuthMaterializationCommand(codexHome: string): string {
  const authPath = `${codexHome}/auth.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(codexHome)}`,
    `cat > ${quoteSshShellArg(authPath)}`,
    `chmod 600 ${quoteSshShellArg(authPath)}`,
  ].join(" && ");
}

// The per-run env file the managed codex command sources for OPENROUTER_API_KEY.
export function codexManagedEnvPath(codexHome: string): string {
  return `${codexHome}/openrouter.env`;
}

// Builds the managed materialization command: writes config.toml (non-secret,
// interpolated) and the key env file (secret, on stdin). The config.toml declares
// the OpenRouter provider per the cookbook; the env file is chmod 600.
export function buildManagedCodexMaterializationCommand(codexHome: string, endpointBaseUrl: string): string {
  const configPath = `${codexHome}/config.toml`;
  const envPath = codexManagedEnvPath(codexHome);
  const configToml = managedCodexConfigToml(endpointBaseUrl);
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(codexHome)}`,
    `cat > ${quoteSshShellArg(envPath)}`,
    `chmod 600 ${quoteSshShellArg(envPath)}`,
    `printf '%s' ${quoteSshShellArg(configToml)} > ${quoteSshShellArg(configPath)}`,
    `chmod 600 ${quoteSshShellArg(configPath)}`,
  ].join(" && ");
}

// The OpenRouter provider block + selector, per OpenRouter's Codex-CLI cookbook.
// `env_key` names the env var (OPENROUTER_API_KEY) the sourced env file exports.
export function managedCodexConfigToml(endpointBaseUrl: string): string {
  return [
    `model_provider = "openrouter"`,
    ``,
    `[model_providers.openrouter]`,
    `name = "openrouter"`,
    `base_url = "${endpointBaseUrl}"`,
    `env_key = "OPENROUTER_API_KEY"`,
    ``,
  ].join("\n");
}

// POSIX single-quote escaping: wrap in single quotes, replacing any embedded
// single quote with the '\'' sequence. Used for values fed to printf / export.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
