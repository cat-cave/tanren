import type { SshCommand } from "../contracts/sshSubstrate.js";

export function quoteSshShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("ssh command argument contains a null byte");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildSshExecCommand(command: SshCommand): string {
  if (command.cwd === undefined || command.cwd === "") {
    return command.command;
  }
  return `cd ${quoteSshShellArg(command.cwd)} && ${command.command}`;
}
