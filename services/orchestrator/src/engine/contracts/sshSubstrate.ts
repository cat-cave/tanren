import type { Failure } from "../failure.js";
import type { SshTarget } from "./allocator.js";

export interface SshCommand {
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface SshCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut: boolean;
  failure?: Failure;
}

export interface SshSubstrate {
  run(target: SshTarget, command: SshCommand): Promise<SshCommandResult>;
}

export class FakeSshSubstrate implements SshSubstrate {
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    return {
      exitCode: 0,
      stdout: `fake ssh: ${command.command}`,
      stderr: "",
      timedOut: false
    };
  }
}
