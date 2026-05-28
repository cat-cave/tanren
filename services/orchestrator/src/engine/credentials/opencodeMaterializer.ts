import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { validateOpencodeAuthBundle, validateOpencodeCredentialRef } from "./opencodeAuth.js";

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
}

export interface MaterializedOpencodeAuth {
  XDG_DATA_HOME: string;
  ref: string;
  redacted: true;
}

export async function materializeOpencodeAuthBundle(input: MaterializeOpencodeAuthInput): Promise<MaterializedOpencodeAuth> {
  const ref = validateOpencodeCredentialRef(input.ref);
  const secret = await input.secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing opencode credential ref: ${ref}`);
  }
  const bundle = validateOpencodeAuthBundle(secret.value);
  const dataHome = opencodeDataHomeForRun(input.runId, input.baseDir);
  const command = buildOpencodeAuthMaterializationCommand(dataHome);
  const result = await input.ssh.run(input.target, { command, stdin: bundle.authJson, timeoutMs: input.timeoutMs ?? 30_000 });
  if (result.failure !== undefined) {
    throw new Error(`opencode credential materialization failed: ${failureMessage(result.failure)}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`opencode credential materialization failed with exit code ${result.exitCode ?? "unknown"}`);
  }
  return { XDG_DATA_HOME: dataHome, ref, redacted: true };
}

function failureMessage(failure: { message?: string; reason?: string }): string {
  return failure.message ?? failure.reason ?? "unknown failure";
}

export function opencodeDataHomeForRun(runId: string, baseDir = "/home/tanren/.tanren/runs"): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("run id is not safe for a runner path");
  }
  return `${baseDir.replace(/\/$/, "")}/${runId}/opencode-home`;
}

export function buildOpencodeAuthMaterializationCommand(dataHome: string): string {
  const authPath = `${dataHome}/opencode/auth.json`;
  return [
    "umask 077",
    `mkdir -p ${quoteSshShellArg(`${dataHome}/opencode`)}`,
    `cat > ${quoteSshShellArg(authPath)}`,
    `chmod 600 ${quoteSshShellArg(authPath)}`
  ].join(" && ");
}
