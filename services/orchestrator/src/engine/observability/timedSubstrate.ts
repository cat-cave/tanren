// observability: a timing decorator for the COMMAND SUBSTRATE boundary.
// It implements the CommandSubstrate contract and delegates to a real substrate,
// emitting one structured timing record per `run()` call. It does NOT change
// the substrate's behavior, retry semantics, or result shape — it only
// measures latency at the boundary. Queue-wait timing is owned by and
// is out of scope.
//
// The emitted attributes are secret-free: the runner backend plus (for the SSH
// backend) host/port/username, and the result's exit code / timeout flag. The
// command string, stdin, and the resolved private key never leave the underlying
// substrate. The decorator reads NO backend reach field off the opaque handle
// directly — it goes through `handleAttributes`, which narrows per backend.
import type { RunnerHandle } from "../contracts/allocator.js";
import { asSshRunnerHandle } from "../contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

// Secret-free telemetry attributes for a runner handle, per backend. The opaque
// base contributes `backend`; the SSH arm adds its (non-secret) host/port/username
// reach fields. A new backend adds its own arm here — the decorator never reaches
// into a handle's transport fields outside this function.
function handleAttributes(handle: RunnerHandle): Record<string, string | number> {
  if (handle.backend === "ssh") {
    const ssh = asSshRunnerHandle(handle);
    return { backend: "ssh", host: ssh.host, port: ssh.port, username: ssh.username };
  }
  return { backend: handle.backend };
}

export class TimedCommandSubstrate implements CommandSubstrate {
  constructor(
    private readonly inner: CommandSubstrate,
    private readonly sink: TimingSink = consoleTimingSink,
  ) {}

  async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const handleAttrs = handleAttributes(handle);
    return timed(
      {
        boundary: "ssh",
        operation: "ssh.run",
        sink: this.sink,
        attributes: handleAttrs,
      },
      async () => {
        const result = await this.inner.run(handle, command);
        // A substrate failure is reported in-band (result.failure) rather than
        // thrown, so surface it as a discrete timing attribute instead of
        // relying on the ok/error outcome alone.
        if (result.failure !== undefined) {
          this.sink({
            event: "timing",
            boundary: "ssh",
            operation: "ssh.run.failed",
            durationMs: 0,
            outcome: "error",
            attributes: { ...handleAttrs, stalled: result.stalled === true },
            timestamp: new Date().toISOString(),
          });
        }
        return result;
      },
    );
  }
}
