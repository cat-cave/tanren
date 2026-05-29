import type { SshTarget } from "../contracts/allocator.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";

export interface WorkspaceSshCommand {
  command: string;
  cwd?: string;
  label: string;
  stdin?: string;
  timeoutMs: number;
}

export class WorkspaceCommandError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly result: SshCommandResult,
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

export async function runWorkspaceSshCommand(
  ssh: SshSubstrate,
  target: SshTarget,
  command: WorkspaceSshCommand,
): Promise<SshCommandResult> {
  const result = await ssh.run(target, command);
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new WorkspaceCommandError(workspaceFailureMessage(command.label, result), command.label, result);
  }
  return result;
}

function workspaceFailureMessage(label: string, result: SshCommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return `${label} failed: ${detail}`;
  }
  if (result.timedOut) {
    return `${label} timed out`;
  }
  return `${label} failed: exit ${result.exitCode ?? "unknown"}`;
}
