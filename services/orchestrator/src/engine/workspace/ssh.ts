import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActivityWatchdog, CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";

export interface WorkspaceSshCommand {
  command: string;
  cwd?: string;
  label: string;
  stdin?: string;
  // The legitimate connect-establishment bound (handshake only). Optional — the
  // substrate defaults it. There is NO wall-clock kill of the running command.
  connectTimeoutMs?: number;
  // The progress-based hang detector (the doctrine's sole running-command safety
  // mechanism). Build via `buildActivityWatchdog` per call class.
  watchdog?: ActivityWatchdog;
}

// The stderr tail surfaced on a failed workspace command. A failed runner
// command must say WHAT failed + WHY (no-silent-fallback / loud-failure
// doctrine), so the typed error carries the failed command + a bounded stderr
// tail. Bounded so a noisy command can't balloon the error/event payload.
const STDERR_TAIL_LIMIT = 2_000;

export class WorkspaceCommandError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

export async function runWorkspaceSshCommand(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  command: WorkspaceSshCommand,
): Promise<CommandResult> {
  const result = await ssh.run(target, command);
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
    throw new WorkspaceCommandError(workspaceFailureMessage(command, result), command.label, result);
  }
  return result;
}

// Builds the loud failure message for a workspace command: the label, the failure
// reason (substrate error / timeout / nonzero exit), the FAILED COMMAND, and a
// bounded stderr tail. A workspace-prep failure (e.g. the bootstrap commit) must
// surface what ran + why it failed — never an opaque `… failed: exit 1`.
function workspaceFailureMessage(command: WorkspaceSshCommand, result: CommandResult): string {
  const reason = failureReason(result);
  return `${command.label} failed: ${reason}; command: ${command.command}${stderrTail(result)}`;
}

function failureReason(result: CommandResult): string {
  if (result.failure !== undefined) {
    return "message" in result.failure ? result.failure.message : result.failure.reason;
  }
  if (result.stalled === true) {
    return "stalled (no sign of life)";
  }
  return `exit ${result.exitCode ?? "unknown"}`;
}

// The trailing stderr (bounded), prefixed for the message. Empty when the failed
// command produced no stderr (its absence is itself a useful signal).
function stderrTail(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr === "") {
    return "";
  }
  const tail = stderr.length <= STDERR_TAIL_LIMIT ? stderr : stderr.slice(stderr.length - STDERR_TAIL_LIMIT);
  return `; stderr: ${tail}`;
}
