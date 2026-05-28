// P3-0006: per-repo workspace bootstrap. Runs clone the target repo into a
// runner workspace but never install its dependencies, so the cloned tree
// cannot build or test — the live acceptance-medium evidence showed the
// checker hitting `vitest: not found`. This step runs the project's install
// command over SSH in the workspace dir immediately after a successful clone
// and BEFORE the first writer iteration, so gating + intent-checking operate
// on a built tree.
import type { SshTarget } from "../contracts/allocator.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";

// The install command tail surfaced on a bootstrap failure. Output can be
// large; we keep only the last N characters so the typed error and the
// recovery surface carry a useful, bounded diagnostic.
const OUTPUT_TAIL_LIMIT = 4_000;

// Default install command. We prefer pnpm (the monorepo + fixture standard)
// but fall back to npm when there is no pnpm lockfile, so a plain-npm repo
// still bootstraps. The detection runs runner-side as part of the command.
//
// TODO: source from tanren-ci.yml (P3-0004) once merged — the install command
// should come from the repo's tanren-ci.yml install step rather than this
// heuristic default. P3-0004 is being built in parallel and is not yet merged,
// so for now the command is a parameter with this sensible default.
export const DEFAULT_BOOTSTRAP_COMMAND =
  'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; else pnpm install; fi';

export interface BootstrapWorkspaceInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  // The install command, run in the workspace dir over SSH. Defaults to
  // DEFAULT_BOOTSTRAP_COMMAND when omitted.
  command?: string;
  timeoutMs: number;
}

// A typed, observable bootstrap failure. Carries the exit code and a bounded
// tail of the combined install output so the halting run outcome and the
// P2B-0008 recovery surface have a concrete diagnostic to show.
export class WorkspaceBootstrapError extends Error {
  readonly name = "WorkspaceBootstrapError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly timedOut: boolean
  ) {
    super(bootstrapFailureMessage(command, exitCode, outputTail, timedOut));
  }
}

// Installs the target repo's dependencies in the cloned workspace over SSH.
// Returns the raw SSH result on success; throws WorkspaceBootstrapError on a
// nonzero exit, timeout, or substrate failure.
export async function bootstrapWorkspace(input: BootstrapWorkspaceInput): Promise<SshCommandResult> {
  const command = input.command ?? DEFAULT_BOOTSTRAP_COMMAND;
  const result = await input.ssh.run(input.target, {
    command,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs
  });

  const succeeded = result.failure === undefined && !result.timedOut && result.exitCode === 0;
  if (!succeeded) {
    throw new WorkspaceBootstrapError(
      input.workspacePath,
      command,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.timedOut
    );
  }
  return result;
}

function combinedOutput(result: SshCommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}

function bootstrapFailureMessage(command: string, exitCode: number | null, outputTail: string, timedOut: boolean): string {
  const reason = timedOut ? "timed out" : `exited ${exitCode ?? "unknown"}`;
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return `workspace bootstrap (${command}) ${reason}${tail}`;
}

// Kept exported so callers that want to build the workspace-dir-scoped command
// string themselves (e.g. for logging) stay consistent with what we run.
export function bootstrapCommandForLog(workspacePath: string, command: string): string {
  return `cd ${quoteSshShellArg(workspacePath)} && ${command}`;
}
