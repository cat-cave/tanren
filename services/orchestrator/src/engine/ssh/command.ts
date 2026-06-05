import type { RunnerCommand } from "../contracts/commandSubstrate.js";

export function quoteSshShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("ssh command argument contains a null byte");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildSshExecCommand(command: RunnerCommand): string {
  if (command.cwd === undefined || command.cwd === "") {
    return command.command;
  }
  return `cd ${quoteSshShellArg(command.cwd)} && ${command.command}`;
}
