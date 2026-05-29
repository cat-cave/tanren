import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateCodexAuthBundle, validateCodexCredentialRef } from "./codexAuth.js";

export interface MaterializeCodexAuthInput {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  ref: string;
  runId: string;
  baseDir?: string;
  timeoutMs?: number;
}

export interface MaterializedCodexAuth {
  CODEX_HOME: string;
  ref: string;
  redacted: true;
}

export async function materializeCodexAuthBundle(input: MaterializeCodexAuthInput): Promise<MaterializedCodexAuth> {
  const ref = validateCodexCredentialRef(input.ref);
  const secret = await input.secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing Codex credential ref: ${ref}`);
  }
  const bundle = validateCodexAuthBundle(secret.value);
  const codexHome = codexHomeForRun(input.runId, input.baseDir);
  const command = buildCodexAuthMaterializationCommand(codexHome);
  const result = await input.ssh.run(input.target, {
    command,
    stdin: bundle.authJson,
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

export function codexHomeForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/, "")}/${runId}/codex-home`;
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
