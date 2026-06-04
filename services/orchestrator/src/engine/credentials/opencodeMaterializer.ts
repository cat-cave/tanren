import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateOpencodeAuthBundle, validateOpencodeCredentialRef } from "./opencodeAuth.js";
import { validateCredentialRef } from "./codexAuth.js";
import { resolveManagedOpenRouterKey } from "./managedKey.js";

// P3-0012: materialize an opencode credential bundle onto the runner under a
// per-run data dir, mirroring the Codex/Claude materializers. opencode reads
// provider credentials from `auth.json` inside its data dir, located via
// XDG_DATA_HOME, so the run's writer points XDG_DATA_HOME at this base.
export interface MaterializeOpencodeAuthInput {
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
  // a Zai opencode auth bundle. Per OpenRouter's opencode cookbook we write
  // `auth.json` ({"openrouter":{"type":"api","key":<key>}}) plus an
  // `opencode.json` declaring `provider.openrouter`, and the writer selects the
  // openrouter provider via `--model openrouter/<model>`. Absent/false ⇒ BYOK:
  // the unchanged Zai-bundle path.
  managed?: boolean;
}

export interface MaterializedOpencodeAuth {
  XDG_DATA_HOME: string;
  ref: string;
  // The config home (XDG_CONFIG_HOME) holding the managed `opencode.json`. Set
  // only for managed runs; the writer exports XDG_CONFIG_HOME at this path so
  // opencode reads the OpenRouter provider config.
  XDG_CONFIG_HOME?: string;
  // Whether this run routes through OpenRouter (managed). The writer reads this
  // to point `--model` at the openrouter provider + export XDG_CONFIG_HOME.
  managed: boolean;
  redacted: true;
}

export async function materializeOpencodeAuthBundle(
  input: MaterializeOpencodeAuthInput,
): Promise<MaterializedOpencodeAuth> {
  const dataHome = opencodeDataHomeForRun(input.runId, input.baseDir);
  if (input.managed === true) {
    const configHome = await materializeManagedOpencode(input, dataHome);
    return {
      XDG_DATA_HOME: dataHome,
      ref: validateCredentialRef(input.ref),
      XDG_CONFIG_HOME: configHome,
      managed: true,
      redacted: true,
    };
  }
  // BYOK (default, unchanged): validate the opencode/ ref + the Zai auth bundle.
  const ref = validateOpencodeCredentialRef(input.ref);
  const secret = await input.secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing opencode credential ref: ${ref}`);
  }
  const bundle = validateOpencodeAuthBundle(secret.value);
  const command = buildOpencodeAuthMaterializationCommand(dataHome);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: bundle.authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(result);
  return { XDG_DATA_HOME: dataHome, ref, managed: false, redacted: true };
}

/**
 * MANAGED materialization (OpenRouter via the opencode cookbook). Writes two
 * files (both chmod 600):
 *   - `<dataHome>/opencode/auth.json` — the cookbook's
 *     `{"openrouter":{"type":"api","key":<key>}}` (secret key on stdin, never in
 *     the command string);
 *   - `<configHome>/opencode/opencode.json` — declares `provider.openrouter` so
 *     opencode resolves the openrouter provider the writer selects via
 *     `--model openrouter/<model>`.
 * Returns the config home for the writer to export as XDG_CONFIG_HOME.
 */
async function materializeManagedOpencode(input: MaterializeOpencodeAuthInput, dataHome: string): Promise<string> {
  const apiKey = await resolveManagedOpenRouterKey(input.secrets, input.ref);
  const configHome = opencodeConfigHomeForRun(input.runId, input.baseDir);
  const authJson = JSON.stringify({ openrouter: { type: "api", key: apiKey } });
  const authResult = await input.ssh.run(input.target, {
    command: buildOpencodeAuthMaterializationCommand(dataHome),
    stdin: authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(authResult);
  // The opencode.json carries no secret, so it is interpolated into the command.
  const configResult = await input.ssh.run(input.target, {
    command: buildManagedOpencodeConfigCommand(configHome),
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  assertMaterializationOk(configResult);
  return configHome;
}

function assertMaterializationOk(result: {
  failure?: { message?: string; reason?: string };
  exitCode: number | null;
}): void {
  if (result.failure !== undefined) {
    throw new Error(`opencode credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`opencode credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
}

function failureMessage(failure: { message?: string; reason?: string }): string {
  return failure.message ?? failure.reason ?? "unknown failure";
}

export function opencodeDataHomeForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/u, "")}/${runId}/opencode-home`;
}

export function opencodeConfigHomeForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/u, "")}/${runId}/opencode-config`;
}

export function buildOpencodeAuthMaterializationCommand(dataHome: string): string {
  const authPath = `${dataHome}/opencode/auth.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(`${dataHome}/opencode`)}`,
    `cat > ${quoteSshShellArg(authPath)}`,
    `chmod 600 ${quoteSshShellArg(authPath)}`,
  ].join(" && ");
}

// Writes the managed `opencode.json` (declaring the OpenRouter provider) into
// <configHome>/opencode. The file carries no secret, so it is interpolated via
// printf into the command.
export function buildManagedOpencodeConfigCommand(configHome: string): string {
  const configPath = `${configHome}/opencode/opencode.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(`${configHome}/opencode`)}`,
    `printf '%s' ${quoteSshShellArg(managedOpencodeConfigJson())} > ${quoteSshShellArg(configPath)}`,
    `chmod 600 ${quoteSshShellArg(configPath)}`,
  ].join(" && ");
}

// The minimal opencode.json declaring the OpenRouter provider, per the cookbook.
// An empty `models` object lets the writer pass any `openrouter/<slug>` model
// via `--model`; the provider's credentials come from the materialized auth.json.
export function managedOpencodeConfigJson(): string {
  return JSON.stringify({ provider: { openrouter: { models: {} } } });
}
