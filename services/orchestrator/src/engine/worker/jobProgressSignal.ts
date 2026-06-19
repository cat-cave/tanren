// JOB-LEVEL PROGRESS SIGNAL — the in-process sign-of-life a wedged-but-heartbeating
// job is detected by (feedback_no_timeouts_progress_based + feedback_monitors_stall_detect,
// BINDING). The lease HEARTBEAT (runHeartbeat.ts) proves a worker thread is ALIVE; it does
// NOT prove the job is making forward PROGRESS. The apex-v45 wedge class: a worker kept its
// lease fresh for HOURS (the heartbeat is a separate timer) while the job made ZERO forward
// progress — stuck on an `await` that never resolved. Liveness ≠ progress, so the heartbeat
// alone must not keep a wedged job alive forever.
//
// This module is the PROGRESS axis the heartbeat consults. It is a monotonic in-process
// COUNTER the worker bumps on every genuine unit of forward motion: every `ssh.run` BOUNDARY
// (a command issued AND a command resolved — see `instrumentSubstrateProgress`). A working
// job is either BETWEEN SSH commands (each boundary bumps) or INSIDE one long SSH command
// whose ActivityWatchdog probe issues its OWN `ssh.run` every cadence (those probe boundaries
// bump too) — so a genuinely-working job ALWAYS advances this counter, even during a
// multi-minute silent codex/gate/clone call. Every stage of a run drives the runner over SSH
// (clone, bootstrap, gate, the writer/checker codex execs, the merge), so SSH boundaries are a
// complete forward-motion signal; there is no separate event-append axis to thread.
//
// A TRULY wedged job advances NOTHING: no SSH boundary fires (the call is stuck on a
// non-resolving await, or it is a pure JS/DB deadlock outside any watchdog-governed call) and
// no event is appended. The heartbeat reads this counter each tick; when it is at a FIXED
// POINT across the lease window (no new motion while the job claims to be running) the job is
// WEDGED and the heartbeat STOPS renewing the lease — the lease lapses and the reaper
// (jobReaper.ts) requeues the run onto a fresh worker. This is PROGRESS-based, NOT a
// wall-clock timeout on working code: a job that bumps the counter (any SSH boundary) is
// making progress and is NEVER touched, no matter how long the whole run takes.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../contracts/commandSubstrate.js";

// A monotonic in-process forward-progress counter for one claimed job. `tick()` bumps it on
// any unit of forward motion; `value()` reads the current count. The heartbeat snapshots
// `value()` each beat and compares the SEQUENCE for advancement — a changing value is
// progress, a fixed value across the lease window is a wedge. Plain integer arithmetic, no
// clock: the trigger is value IDENTITY across checks, never elapsed time.
export class JobProgressSignal {
  private count = 0;

  /** Record one unit of forward motion (an SSH boundary). */
  tick(): void {
    this.count += 1;
  }

  /** The current forward-progress count (monotonic, non-decreasing). */
  value(): number {
    return this.count;
  }
}

// Wrap a `CommandSubstrate` so every `run` BOUNDARY (entry AND exit) ticks the progress
// signal. Entry-tick: issuing a command is forward motion. Exit-tick: a command resolving
// (success, failure, OR a watchdog-surfaced stall) is forward motion — and the ActivityWatchdog
// probe's own `ssh.run`, issued every cadence during a long silent op, exits here too, so a job
// inside a multi-minute codex/gate call keeps advancing the signal via the probe boundaries and
// is never falsely flagged. A truly dead call neither enters nor exits again → no further ticks.
export function instrumentSubstrateProgress(inner: CommandSubstrate, signal: JobProgressSignal): CommandSubstrate {
  return {
    async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      signal.tick();
      try {
        return await inner.run(handle, command);
      } finally {
        signal.tick();
      }
    },
  };
}
