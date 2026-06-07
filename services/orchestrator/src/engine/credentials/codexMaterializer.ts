import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { CommandFileSubstrate } from "../ssh/commandFileSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateCodexAuthBundle, validateCodexCredentialRef, validateCredentialRef } from "./codexAuth.js";
import { resolveRawProviderKey } from "./managedKey.js";
import { credentialTypeForRef, providerSlugForRef } from "./credentialType.js";
import { DEFAULT_MANAGED_ENDPOINT } from "../config/managedProvider.js";

export interface MaterializeCodexAuthInput {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
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
  // routes THROUGH OpenRouter. Absent/false ⇒ BYOK: the codex-bundle path OR, for
  // a raw `api_key` ref (the BYOK widening below), the native env-key path.
  managed?: boolean;
  // The OpenRouter base URL the cookbook's `[model_providers.openrouter]` block
  // points `base_url` at (e.g. `https://openrouter.ai/api/v1`). Required (and only
  // consulted) when the run routes THROUGH OpenRouter (managed mode OR a BYOK
  // `credential/openrouter/` api_key). A BYOK OpenRouter key with no override
  // falls back to DEFAULT_MANAGED_ENDPOINT (OpenRouter's own default base URL).
  endpointBaseUrl?: string;
}

export interface MaterializedCodexAuth {
  CODEX_HOME: string;
  ref: string;
  // Whether this run routes codex THROUGH OpenRouter via a per-run config.toml —
  // true for managed mode AND for a BYOK `credential/openrouter/` api_key. The
  // command builder reads this to source the OPENROUTER_API_KEY env file and to
  // honor the CODEX_HOME config.toml instead of passing `--ignore-user-config`.
  managed: boolean;
  // The native env file the command must source (chmod 600, exporting a single
  // provider key). Set for the BYOK native-OpenAI api_key path
  // (`credential/openai-api/` → OPENAI_API_KEY): codex talks to OpenAI directly,
  // so there is NO config.toml and `--ignore-user-config` STAYS on. Absent for the
  // bundle path and the OpenRouter (config.toml) paths.
  nativeApiKeyEnvFile?: string;
  // Whether the materialized auth is a rotating Codex ChatGPT token bundle
  // (the BYOK bundle path). Only that path writes an auth.json codex rotates, so
  // it is the only path the adapter writes the refreshed bundle back for. The
  // api_key / managed paths authenticate with a static key — nothing to refresh.
  bundleAuth: boolean;
  redacted: true;
}

export async function materializeCodexAuthBundle(input: MaterializeCodexAuthInput): Promise<MaterializedCodexAuth> {
  const codexHome = codexHomeForRun(input.runId, input.baseDir);
  if (input.managed === true) {
    await materializeManagedOpenRouterCodexConfig(input, codexHome, requiredManagedEndpoint(input.endpointBaseUrl));
    return {
      CODEX_HOME: codexHome,
      ref: validateCredentialRef(input.ref),
      managed: true,
      bundleAuth: false,
      redacted: true,
    };
  }
  // BYOK WIDENING: a raw `api_key` ref (NOT a codex bundle, NOT managed mode)
  // delivers the TENANT's own key via the provider's env mechanism, dispatching
  // on the provider slug.
  const credentialType = credentialTypeForRef(input.ref);
  if (credentialType === "api_key") {
    return materializeByokApiKeyCodexAuth(input, codexHome);
  }
  // BYOK (default, unchanged): validate the codex/ ref + the ChatGPT token bundle
  // and write codex's auth.json. The secret bytes go through the FILE SUBSTRATE
  // seam (a chmod-600 write, content on stdin) — the named form of the heredoc
  // that wrote auth.json inline before.
  const { ref, authJson } = await resolveCodexBundleAuthJson(input.secrets, input.ref);
  const files = new CommandFileSubstrate(input.ssh);
  const result = await files.writeFile(input.target, {
    path: `${codexHome}/auth.json`,
    content: authJson,
    mode: 0o600,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertFileWriteOk(result, "Codex");
  return { CODEX_HOME: codexHome, ref, managed: false, bundleAuth: true, redacted: true };
}

/**
 * BYOK api_key materialization (the credential-redesign widening): the tenant's
 * own raw provider key, delivered via codex's env-key mechanism. Dispatches on
 * the provider slug:
 *   - `credential/openrouter/` → REUSE the OpenRouter config.toml mechanism
 *     (`[model_providers.openrouter]` + OPENROUTER_API_KEY env file), but with the
 *     TENANT's key and (absent an endpoint override) OpenRouter's default base URL
 *     (DEFAULT_MANAGED_ENDPOINT). Identical wire-up to managed mode — the only
 *     difference is WHOSE key — so the return carries `managed: true`.
 *   - `credential/openai-api/` → codex NATIVE OpenAI: write only an OPENAI_API_KEY
 *     env file (chmod 600, secret on stdin), NO config.toml / base_url override.
 *     codex hits OpenAI directly, so `--ignore-user-config` stays on.
 * Any other api_key slug (none today) is a LOUD failure — never a silent default.
 */
async function materializeByokApiKeyCodexAuth(
  input: MaterializeCodexAuthInput,
  codexHome: string,
): Promise<MaterializedCodexAuth> {
  const slug = providerSlugForRef(input.ref);
  if (slug === "openrouter") {
    // The TENANT's OpenRouter key over the same cookbook wire-up as managed; a
    // BYOK key with no explicit endpoint uses OpenRouter's default base URL.
    const endpoint =
      input.endpointBaseUrl?.trim() === "" || input.endpointBaseUrl === undefined
        ? DEFAULT_MANAGED_ENDPOINT
        : input.endpointBaseUrl;
    await materializeManagedOpenRouterCodexConfig(input, codexHome, endpoint);
    return {
      CODEX_HOME: codexHome,
      ref: validateCredentialRef(input.ref),
      managed: true,
      bundleAuth: false,
      redacted: true,
    };
  }
  if (slug === "openai-api") {
    await materializeNativeOpenAiCodexEnv(input, codexHome);
    return {
      CODEX_HOME: codexHome,
      ref: validateCredentialRef(input.ref),
      managed: false,
      nativeApiKeyEnvFile: codexNativeKeyEnvPath(codexHome),
      bundleAuth: false,
      redacted: true,
    };
  }
  // No silent fallback: an api_key slug codex has no delivery for must fail loud.
  throw new Error(`codex cannot deliver a BYOK api_key for provider slug ${JSON.stringify(slug)}`);
}

function requiredManagedEndpoint(endpointBaseUrl?: string): string {
  if (endpointBaseUrl === undefined || endpointBaseUrl.trim() === "") {
    // No silent fallback: a managed codex run with no endpoint is a wiring bug.
    throw new Error("managed Codex run requires an endpoint base URL for the OpenRouter provider block");
  }
  return endpointBaseUrl;
}

/**
 * OpenRouter materialization (the Codex-CLI cookbook), shared by managed mode and
 * the BYOK `credential/openrouter/` api_key path. Writes two files into the
 * per-run CODEX_HOME:
 *   - `config.toml` — `model_provider = "openrouter"` plus the
 *     `[model_providers.openrouter]` block (`base_url`, `env_key`), so `codex
 *     exec` (run with this CODEX_HOME, NOT `--ignore-user-config`) routes through
 *     OpenRouter;
 *   - a key env file (chmod 600) exporting `OPENROUTER_API_KEY=<key>` — the
 *     secret VALUE lives only in this file, never in the command string/events.
 * The command builder sources the env file before `codex exec`.
 */
async function materializeManagedOpenRouterCodexConfig(
  input: MaterializeCodexAuthInput,
  codexHome: string,
  endpointBaseUrl: string,
): Promise<void> {
  const apiKey = await resolveRawProviderKey(input.secrets, input.ref);
  const result = await input.ssh.run(input.target, {
    command: buildManagedCodexMaterializationCommand(codexHome, endpointBaseUrl),
    // The secret key is fed on stdin and the command writes it into the chmod-600
    // env file — it is never interpolated into the command string.
    stdin: `export OPENROUTER_API_KEY=${shellSingleQuote(apiKey)}\n`,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
}

/**
 * NATIVE OpenAI materialization (the BYOK `credential/openai-api/` path). codex
 * talks to OpenAI directly, so we write ONLY a chmod-600 env file exporting
 * `OPENAI_API_KEY=<key>` (secret on stdin) — no config.toml, no base_url override.
 * The command builder sources this env file and KEEPS `--ignore-user-config`.
 */
async function materializeNativeOpenAiCodexEnv(input: MaterializeCodexAuthInput, codexHome: string): Promise<void> {
  const apiKey = await resolveRawProviderKey(input.secrets, input.ref);
  const result = await input.ssh.run(input.target, {
    command: buildNativeOpenAiCodexEnvCommand(codexHome),
    // The secret key rides stdin into the chmod-600 env file — never the command.
    stdin: `export OPENAI_API_KEY=${shellSingleQuote(apiKey)}\n`,
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

// Assert a FileSubstrate write succeeded, mirroring assertMaterializationOk's loud
// failure (a credential write that did not land must halt the run, never degrade).
function assertFileWriteOk(
  result: { ok: boolean; failure?: { message?: string; reason?: string } },
  cli: string,
): void {
  if (!result.ok) {
    const detail = result.failure === undefined ? "unknown failure" : failureMessage(result.failure);
    throw new Error(`${cli} credential materialization failed: ${detail}`);
  }
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

// The per-run env file the managed codex command sources for OPENROUTER_API_KEY.
export function codexManagedEnvPath(codexHome: string): string {
  return `${codexHome}/openrouter.env`;
}

// The per-run env file the BYOK native-OpenAI codex command sources for
// OPENAI_API_KEY (distinct from the OpenRouter env file — codex hits OpenAI
// directly with no config.toml).
export function codexNativeKeyEnvPath(codexHome: string): string {
  return `${codexHome}/openai.env`;
}

// Builds the BYOK native-OpenAI materialization command: writes ONLY the chmod-600
// OPENAI_API_KEY env file (secret on stdin). NO config.toml — codex talks to OpenAI
// directly, so the exec keeps `--ignore-user-config` and just sources this file.
export function buildNativeOpenAiCodexEnvCommand(codexHome: string): string {
  const envPath = codexNativeKeyEnvPath(codexHome);
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(codexHome)}`,
    `cat > ${quoteSshShellArg(envPath)}`,
    `chmod 600 ${quoteSshShellArg(envPath)}`,
  ].join(" && ");
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
