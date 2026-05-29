// P3-0029 observability: a timing decorator for the SSH substrate boundary.
// It implements the SshSubstrate contract and delegates to a real substrate,
// emitting one structured timing record per `run()` call. It does NOT change
// the substrate's behavior, retry semantics, or result shape — it only
// measures latency at the boundary. Queue-wait timing is owned by P3-0028 and
// is out of scope.
//
// The emitted attributes are secret-free: host/port/username and the result's
// exit code / timeout flag. The command string, stdin, and the resolved
// private key never leave the underlying substrate.
import type { SshTarget } from "../contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

export class TimedSshSubstrate implements SshSubstrate {
  constructor(
    private readonly inner: SshSubstrate,
    private readonly sink: TimingSink = consoleTimingSink,
  ) {}

  async run(target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    return timed(
      {
        boundary: "ssh",
        operation: "ssh.run",
        sink: this.sink,
        attributes: { host: target.host, port: target.port, username: target.username },
      },
      async () => {
        const result = await this.inner.run(target, command);
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
            attributes: { host: target.host, port: target.port, timedOut: result.timedOut },
            timestamp: new Date().toISOString(),
          });
        }
        return result;
      },
    );
  }
}
