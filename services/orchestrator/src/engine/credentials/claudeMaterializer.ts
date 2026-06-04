import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateClaudeAuthBundle, validateClaudeCredentialRef } from "./claudeAuth.js";
import { validateCredentialRef } from "./codexAuth.js";
import { resolveManagedOpenRouterKey } from "./managedKey.js";

// P3-0012: materialize a Claude CLI credential bundle onto the runner under a
// per-run CLAUDE_CONFIG_DIR, mirroring the Codex materializer. The Claude CLI
// reads its session credentials from `.credentials.json` inside the config dir,
// so the run's writer/answerer all point CLAUDE_CONFIG_DIR at the same path.
export interface MaterializeClaudeAuthInput {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  runId: string;
  baseDir?: string;
  timeoutMs?: number;
  // SaaS Tier-B #5: MANAGED mode. When true, the run resolved the platform
  // OpenRouter shell and `ref` is a plain API-KEY credential
  // (credential/openrouter/…) whose stored secret is the raw OpenRouter key, NOT
  // a Claude `.credentials.json` token bundle. Per OpenRouter's Claude-Code
  // cookbook we instead write a `settings.json` into CLAUDE_CONFIG_DIR carrying
  // the `env` block (ANTHROPIC_BASE_URL=https://openrouter.ai/api,
  // ANTHROPIC_AUTH_TOKEN=<key>, ANTHROPIC_API_KEY="") so the CLI routes THROUGH
  // OpenRouter. Absent/false ⇒ BYOK: the unchanged `.credentials.json` path.
  managed?: boolean;
  // The managed OpenRouter base URL the run resolved (e.g.
  // `https://openrouter.ai/api/v1`). The Claude cookbook needs the `/api` base
  // (NOT `/api/v1`), so this is mapped via `claudeAnthropicBaseUrl`. Required
  // (and only consulted) when `managed` is true.
  endpointBaseUrl?: string;
}

export interface MaterializedClaudeAuth {
  CLAUDE_CONFIG_DIR: string;
  ref: string;
  // The Anthropic-compatible base URL the command must export as
  // ANTHROPIC_BASE_URL (the `/api` form for managed; undefined for BYOK).
  anthropicBaseUrl?: string;
  // Whether this run routes through OpenRouter (managed). The command builder
  // reads this to blank ANTHROPIC_API_KEY + set the base URL.
  managed: boolean;
  redacted: true;
}

export async function materializeClaudeAuthBundle(input: MaterializeClaudeAuthInput): Promise<MaterializedClaudeAuth> {
  const configDir = claudeConfigDirForRun(input.runId, input.baseDir);
  if (input.managed === true) {
    const anthropicBaseUrl = await materializeManagedClaudeSettings(input, configDir);
    return {
      CLAUDE_CONFIG_DIR: configDir,
      ref: validateCredentialRef(input.ref),
      anthropicBaseUrl,
      managed: true,
      redacted: true,
    };
  }
  // BYOK (default, unchanged): validate the claude/ ref + the `.credentials.json`
  // token bundle and materialize it.
  const ref = validateClaudeCredentialRef(input.ref);
  const secret = await input.secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing Claude credential ref: ${ref}`);
  }
  const bundle = validateClaudeAuthBundle(secret.value);
  const command = buildClaudeAuthMaterializationCommand(configDir);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: bundle.authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
  return { CLAUDE_CONFIG_DIR: configDir, ref, managed: false, redacted: true };
}

/**
 * MANAGED materialization (OpenRouter via the Claude-Code cookbook). Writes
 * `settings.json` (chmod 600) into CLAUDE_CONFIG_DIR with the cookbook's exact
 * `env` block. The secret AUTH_TOKEN lives ONLY in this file (fed on stdin),
 * never in the command string/events. Returns the Anthropic-compatible base URL
 * (the `/api` form) for the command builder to also export as ANTHROPIC_BASE_URL.
 */
async function materializeManagedClaudeSettings(input: MaterializeClaudeAuthInput, configDir: string): Promise<string> {
  if (input.endpointBaseUrl === undefined || input.endpointBaseUrl.trim() === "") {
    // No silent fallback: a managed claude run with no endpoint is a wiring bug.
    throw new Error("managed Claude run requires an endpoint base URL");
  }
  const anthropicBaseUrl = claudeAnthropicBaseUrl(input.endpointBaseUrl);
  const apiKey = await resolveManagedOpenRouterKey(input.secrets, input.ref);
  const settingsJson = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: "",
    },
  });
  const result = await input.ssh.run(input.target, {
    command: buildManagedClaudeSettingsCommand(configDir),
    stdin: settingsJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
  return anthropicBaseUrl;
}

// Maps the resolved OpenRouter endpoint (`…/api/v1`) to the Anthropic-compatible
// base the Claude-Code cookbook requires (`…/api`, NOT `…/api/v1`). A trailing
// `/v1` is stripped; an endpoint already at `/api` is returned unchanged.
export function claudeAnthropicBaseUrl(endpointBaseUrl: string): string {
  return endpointBaseUrl.replace(/\/v1\/?$/u, "");
}

function assertMaterializationOk(result: {
  failure?: { message?: string; reason?: string };
  exitCode: number | null;
}): void {
  if (result.failure !== undefined) {
    throw new Error(`Claude credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Claude credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
}

function failureMessage(failure: { message?: string; reason?: string }): string {
  return failure.message ?? failure.reason ?? "unknown failure";
}

export function claudeConfigDirForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/u, "")}/${runId}/claude-home`;
}

export function buildClaudeAuthMaterializationCommand(configDir: string): string {
  const credentialsPath = `${configDir}/.credentials.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(configDir)}`,
    `cat > ${quoteSshShellArg(credentialsPath)}`,
    `chmod 600 ${quoteSshShellArg(credentialsPath)}`,
  ].join(" && ");
}

// Writes the managed `settings.json` (with the OpenRouter env block) into
// CLAUDE_CONFIG_DIR. The file content arrives on stdin (so the AUTH_TOKEN secret
// never enters the command string).
export function buildManagedClaudeSettingsCommand(configDir: string): string {
  const settingsPath = `${configDir}/settings.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(configDir)}`,
    `cat > ${quoteSshShellArg(settingsPath)}`,
    `chmod 600 ${quoteSshShellArg(settingsPath)}`,
  ].join(" && ");
}
