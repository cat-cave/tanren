import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateClaudeAuthBundle, validateClaudeCredentialRef } from "./claudeAuth.js";

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
}

export interface MaterializedClaudeAuth {
  CLAUDE_CONFIG_DIR: string;
  ref: string;
  redacted: true;
}

export async function materializeClaudeAuthBundle(input: MaterializeClaudeAuthInput): Promise<MaterializedClaudeAuth> {
  const ref = validateClaudeCredentialRef(input.ref);
  const secret = await input.secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing Claude credential ref: ${ref}`);
  }
  const bundle = validateClaudeAuthBundle(secret.value);
  const configDir = claudeConfigDirForRun(input.runId, input.baseDir);
  const command = buildClaudeAuthMaterializationCommand(configDir);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: bundle.authJson,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
  if (result.failure !== undefined) {
    throw new Error(`Claude credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Claude credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
  return { CLAUDE_CONFIG_DIR: configDir, ref, redacted: true };
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
