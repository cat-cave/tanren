import type { SshTarget } from "./allocator.js";

export interface SshCommand {
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface SshCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SshSubstrate {
  run(target: SshTarget, command: SshCommand): Promise<SshCommandResult>;
}

export class FakeSshSubstrate implements SshSubstrate {
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    return {
      exitCode: 0,
      stdout: `fake ssh: ${command.command}`,
      stderr: ""
    };
  }
}
