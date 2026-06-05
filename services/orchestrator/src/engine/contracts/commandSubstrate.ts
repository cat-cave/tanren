// The COMMAND SUBSTRATE seam — the backend-neutral boundary at which the
// orchestrator runs a command inside an allocated runner. This is the single
// swappable boundary every backend must satisfy: the engine never knows whether
// the command runs over SSH to a container/VM, a native-exec API (Sprites /
// Daytona), or a micro-VM (Fly Machines). It only knows it hands a
// {@link RunnerHandle} + a {@link RunnerCommand} to a `CommandSubstrate` and
// gets a {@link CommandResult} back.
//
// The handle is OPAQUE at this contract: the substrate that produced it knows
// how to reach the runner (the SSH impl's handle carries host/port/identity;
// see {@link RunnerHandle} in ./allocator.js). Engine code threads the handle
// through unchanged — it never reads transport fields off it.
//
// SSH is the ONE concrete impl today ({@link SshCommandSubstrate} in
// engine/ssh/ssh2Substrate.ts). New backends slot in as a new `CommandSubstrate`
// impl (a documented seam arm), NOT a refactor of the consumers.
import type { Failure } from "../failure.js";
import type { RunnerHandle } from "./allocator.js";

// One command to run in a runner. Backend-neutral: stdin is piped, cwd scopes the
// working directory, timeoutMs bounds the call. The substrate redacts none of
// this into logs — the command string / stdin / any materialized identity never
// leave the substrate impl.
export interface RunnerCommand {
  command: string;
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
}

// The outcome of one command. A substrate (transport) failure is reported
// IN-BAND via `failure` rather than thrown, so consumers branch on the result
// shape uniformly across backends. `exitCode` is the runner process's code
// (null when the command never produced one — e.g. a connection failure).
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut: boolean;
  failure?: Failure;
}

// THE seam. `run()` executes one command in the runner the handle addresses.
// Backend-neutral vocabulary: an SSH backend speaks ssh2, a native-exec backend
// calls its exec API — the engine sees only this method.
export interface CommandSubstrate {
  run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult>;
}

// A no-op CommandSubstrate for unit paths that drive the workflow with fake
// writers (the command output is irrelevant to the assertion). TEST FIXTURE
// ONLY — never the live path.
export class FakeCommandSubstrate implements CommandSubstrate {
  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    return {
      exitCode: 0,
      stdout: `fake command: ${command.command}`,
      stderr: "",
      timedOut: false,
    };
  }
}
