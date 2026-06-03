import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateCodexAuthBundle, validateCodexCredentialRef, validateCredentialRef } from "./codexAuth.js";

export interface MaterializeCodexAuthInput {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  runId: string;
  baseDir?: string;
  timeoutMs?: number;
  // SaaS Tier-B #5: MANAGED mode. When true, the run resolved the platform
  // OpenRouter shell (an OpenAI-compatible endpoint, set via OPENAI_BASE_URL in
  // the codex exec command) and `ref` is a plain API-KEY credential
  // (credential/openrouter/…, credential/anthropic/…, credential/openai-api/…)
  // whose stored secret is the raw key string `sk-…`, NOT a Codex ChatGPT
  // auth-bundle JSON. In that mode we MUST NOT run the codex-ref / codex-bundle
  // validators (the ref is not credential/codex/ and the value is not a token
  // bundle). Instead we materialize codex's documented API-key auth.json
  // (`{"OPENAI_API_KEY": "<key>"}`) so codex authenticates against the managed
  // endpoint with the platform key. Absent/false ⇒ BYOK: the unchanged
  // codex-bundle path.
  managed?: boolean;
}

export interface MaterializedCodexAuth {
  CODEX_HOME: string;
  ref: string;
  redacted: true;
}

export async function materializeCodexAuthBundle(input: MaterializeCodexAuthInput): Promise<MaterializedCodexAuth> {
  // BYOK (default): validate the codex/ ref + the ChatGPT token bundle.
  // MANAGED: the credential is a plain OpenAI-compatible API key under a
  // non-codex provider ref — validate only the generic ref grammar and wrap the
  // raw key as codex's API-key auth.json. The two paths NEVER cross-validate:
  // a managed API key would fail the codex-bundle check, and a BYOK bundle ref
  // is not a provider API-key ref.
  const { ref, authJson } = input.managed
    ? await resolveManagedApiKeyAuthJson(input.secrets, input.ref)
    : await resolveCodexBundleAuthJson(input.secrets, input.ref);
  const codexHome = codexHomeForRun(input.runId, input.baseDir);
  const command = buildCodexAuthMaterializationCommand(codexHome);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  if (result.failure !== undefined) {
    throw new Error(`Codex credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Codex credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
  return { CODEX_HOME: codexHome, ref, redacted: true };
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

/**
 * MANAGED resolution: the ref is a plain OpenAI-compatible API-key credential
 * (e.g. `credential/openrouter/platform/default`) and the stored secret is the
 * raw key string. We validate ONLY the generic managed-ref grammar (NOT the
 * codex-ref / codex-bundle validators, which would reject both the ref and the
 * value), then wrap the key as codex's documented API-key auth.json shape
 * (`{"OPENAI_API_KEY": "<key>"}`). Codex authenticates with this key against the
 * managed endpoint (OPENAI_BASE_URL, set in the codex exec command). The key is
 * trimmed to reject a whitespace-only secret loudly rather than writing an empty
 * key codex would silently fail on.
 */
async function resolveManagedApiKeyAuthJson(
  secrets: SecretStore,
  rawRef: string,
): Promise<{ ref: string; authJson: string }> {
  const ref = validateCredentialRef(rawRef);
  const secret = await secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing managed LLM credential ref: ${ref}`);
  }
  const apiKey = secret.value.trim();
  if (apiKey === "") {
    throw new Error(`managed LLM credential ref ${ref} resolved to an empty api key`);
  }
  return { ref, authJson: JSON.stringify({ OPENAI_API_KEY: apiKey }) };
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
