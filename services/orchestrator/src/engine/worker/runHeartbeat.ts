// runHeartbeat — the claimed-job lease-renewal loop, extracted from runExecutor.ts
// (file-size cap). A claimed plan job renews its queue lease on an interval while
// the (potentially long) workflow runs; a crashed worker stops renewing, its lease
// lapses, and the reaper recovers the job.
//
// Heartbeat misses are NO LONGER silently swallowed (silent-fallback hardening,
// finding 9): a single transient DB blip should not kill the job, but EVERY miss
// is LOGGED + counted (consecutive misses, reset on the next success). Once the
// consecutive misses have consumed the lease window — `consecutiveMisses ×
// intervalMs ≥ leaseMs` — the lease can lapse while the job still runs, so the
// reaper may requeue it (DUPLICATE execution). That `atRisk` crossing is surfaced
// LOUDLY (the default sink logs an error; the `onMiss` seam lets a caller react)
// rather than letting a persistent renewal failure silently risk a double-execute.
//
// PROGRESS-BASED STALL DETECTION (apex-v45, feedback_no_timeouts_progress_based +
// feedback_monitors_stall_detect, BINDING): the heartbeat proves the worker thread
// is ALIVE; it does NOT prove the job makes forward PROGRESS. A job WEDGED on a
// non-resolving `await` keeps heartbeating (the heartbeat is a separate timer) while
// making ZERO progress — the apex-v45 hang sat for hours, undetected, because the
// lease stayed fresh. So when a `JobProgressSignal` is wired, the heartbeat consults
// it each beat: while the signal ADVANCES (any SSH boundary — including an
// ActivityWatchdog probe's own cadence `ssh.run` during a long silent call) the lease
// is renewed UNBOUNDED (a working job is never touched, no matter the total run time);
// when the signal is at a FIXED POINT for the whole LEASE WINDOW (no forward motion
// across `ceil(leaseMs/intervalMs)` consecutive beats) the job is WEDGED and the
// heartbeat STOPS renewing — the lease lapses and the reaper requeues the run onto a
// fresh worker. This is PROGRESS-based, NOT a wall-clock timeout on working code: the
// trigger is the progress signal's NON-ADVANCEMENT across the window, never elapsed time.

import { createLogger } from "../observability/logger.js";
import type { JobProgressSignal } from "./jobProgressSignal.js";
// Re-export the progress-signal seam so the executor (which already imports runHeartbeat)
// wires it WITHOUT taking a separate module dependency (keeps runExecutor under its dep cap).
export { JobProgressSignal, instrumentSubstrateProgress } from "./jobProgressSignal.js";

const log = createLogger("run-executor");

// A single heartbeat miss, surfaced to the observability sink.
export interface HeartbeatMiss {
  jobId: string;
  consecutiveMisses: number;
  // True once the consecutive misses have consumed the lease window — the reaper
  // may now requeue this still-running job (duplicate-execution risk).
  atRisk: boolean;
  detail: string;
}

// A detected job WEDGE: the progress signal did not advance across the whole lease
// window while the job kept heartbeating. Surfaced to the stall sink; the heartbeat
// then STOPS renewing the lease so the reaper recovers the run.
export interface JobStall {
  jobId: string;
  // The consecutive beats over which the progress signal did not advance — at least
  // the lease window (so the lease is about to lapse for the reaper to recover).
  nonAdvancingBeats: number;
  // The fixed progress-signal value the job is wedged at (evidence: this many forward
  // units of motion happened, then none — diagnostic only, NOT a duration).
  progressValue: number;
}

export interface HeartbeatConfig {
  // The lease-renewal call (the DB-CAS / control-plane heartbeat).
  heartbeat: (jobId: string, leaseMs: number) => Promise<unknown>;
  jobId: string;
  leaseMs: number;
  intervalMs: number;
  // The miss observability sink; defaults to a loud console logger.
  onMiss?: (miss: HeartbeatMiss) => void;
  // PROGRESS-BASED STALL DETECTION: the in-process forward-motion signal. When wired,
  // each beat reads `signal.value()`; a job whose signal does not advance across the
  // whole lease window is WEDGED → the heartbeat stops renewing (lease lapses, reaper
  // recovers). Omitted (unit paths with no real workflow) ⇒ no stall detection, the
  // heartbeat renews unconditionally exactly as before (behavior-identical).
  progressSignal?: JobProgressSignal;
  // The wedge observability sink; defaults to a loud console error. Invoked ONCE when
  // a stall is detected (right before the heartbeat stops renewing). Tests inject it
  // to assert the detection without a real reaper.
  onStall?: (stall: JobStall) => void;
}

// Start the renewal loop; returns a stopper that cancels it and resolves once the
// in-flight beat has settled.
export function startHeartbeat(config: HeartbeatConfig): () => Promise<void> {
  const intervalMs = Math.max(1, config.intervalMs);
  // The consecutive misses that exhaust the lease window — beyond this the reaper
  // may requeue a still-running job. At least 1 so a degenerate lease still trips.
  const atRiskThreshold = Math.max(1, Math.ceil(config.leaseMs / intervalMs));
  const onMiss = config.onMiss ?? defaultHeartbeatMissSink;
  const onStall = config.onStall ?? defaultJobStallSink;
  const control = {
    running: true,
    inFlight: Promise.resolve(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    consecutiveMisses: 0,
    // PROGRESS-BASED STALL state: the last observed progress-signal value and how many
    // CONSECUTIVE beats it has not advanced. A stall is declared when the non-advancing
    // streak reaches the lease window (`atRiskThreshold`) — the same window beyond which
    // a missed-heartbeat streak would let the lease lapse, so the reaper recovers either way.
    lastProgressValue: config.progressSignal?.value() ?? 0,
    nonAdvancingBeats: 0,
    stalled: false,
  };

  const recordMiss = (error: unknown): void => {
    control.consecutiveMisses += 1;
    onMiss({
      jobId: config.jobId,
      consecutiveMisses: control.consecutiveMisses,
      atRisk: control.consecutiveMisses >= atRiskThreshold,
      detail: messageOf(error),
    });
  };

  // PROGRESS check (runs each beat BEFORE the renewal when a signal is wired). Reads the
  // current forward-motion count: an ADVANCE resets the non-advancing streak (progress —
  // renew unbounded); NO advance increments it. Returns `true` (a WEDGE) once the streak
  // reaches the lease window — the job heartbeated but made no forward motion for the whole
  // window. PURE value comparison, no clock: the trigger is signal IDENTITY across beats.
  const isWedged = (): boolean => {
    if (config.progressSignal === undefined || control.stalled) {
      return control.stalled;
    }
    const current = config.progressSignal.value();
    if (current > control.lastProgressValue) {
      control.lastProgressValue = current;
      control.nonAdvancingBeats = 0;
      return false;
    }
    control.nonAdvancingBeats += 1;
    if (control.nonAdvancingBeats < atRiskThreshold) {
      return false;
    }
    control.stalled = true;
    onStall({
      jobId: config.jobId,
      nonAdvancingBeats: control.nonAdvancingBeats,
      progressValue: current,
    });
    return true;
  };

  const schedule = (): void => {
    if (!control.running) {
      return;
    }
    control.timer = setTimeout(() => {
      // PROGRESS-BASED STALL: before renewing, check forward motion. A WEDGED job (no
      // progress across the whole lease window) STOPS renewing — the loop ends, the lease
      // lapses, and the reaper requeues the run onto a fresh worker. A working job (any
      // forward motion) renews unconditionally, UNBOUNDED. The wedged worker thread itself
      // is abandoned on its non-resolving await — releasing the lease is the only correct
      // recovery for an un-interruptible in-process hang.
      if (isWedged()) {
        control.running = false;
        return;
      }
      // A miss is LOGGED + counted, never silently swallowed. A success resets the
      // consecutive-miss counter. The job is not killed on a transient blip, but a
      // sustained miss-streak crossing the lease window is surfaced loudly.
      control.inFlight = config
        .heartbeat(config.jobId, config.leaseMs)
        .then(() => {
          control.consecutiveMisses = 0;
        })
        .catch((error: unknown) => {
          recordMiss(error);
        })
        .then(schedule);
    }, intervalMs);
    if (typeof control.timer.unref === "function") {
      control.timer.unref();
    }
  };

  schedule();

  return async () => {
    control.running = false;
    if (control.timer !== undefined) {
      clearTimeout(control.timer);
    }
    await control.inFlight;
  };
}

// The default heartbeat-miss sink: log EVERY miss; escalate to an error log once
// the miss-streak has consumed the lease window (reaper-double-execute risk).
function defaultHeartbeatMissSink(miss: HeartbeatMiss): void {
  const context = { jobId: miss.jobId, consecutiveMisses: miss.consecutiveMisses, detail: miss.detail };
  if (miss.atRisk) {
    log.error(
      "heartbeat miss — consecutive misses have consumed the lease window; the reaper may requeue this " +
        "still-running job (duplicate execution risk)",
      context,
    );
  } else {
    log.warn("heartbeat miss", context);
  }
}

// The default job-stall sink: a LOUD error. The job heartbeated but made NO forward
// progress for the whole lease window — a wedge. The heartbeat is about to stop
// renewing so the reaper recovers the run; surface it for operator triage.
function defaultJobStallSink(stall: JobStall): void {
  log.error(
    "job WEDGED — heartbeating but no forward progress for the whole lease window; releasing the lease so " +
      "the reaper requeues this run onto a fresh worker (the wedged worker thread is abandoned on a " +
      "non-resolving await)",
    { jobId: stall.jobId, nonAdvancingBeats: stall.nonAdvancingBeats, progressValue: stall.progressValue },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
