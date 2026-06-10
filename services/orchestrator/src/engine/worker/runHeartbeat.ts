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

import { createLogger } from "../observability/logger.js";

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

export interface HeartbeatConfig {
  // The lease-renewal call (the DB-CAS / control-plane heartbeat).
  heartbeat: (jobId: string, leaseMs: number) => Promise<unknown>;
  jobId: string;
  leaseMs: number;
  intervalMs: number;
  // The miss observability sink; defaults to a loud console logger.
  onMiss?: (miss: HeartbeatMiss) => void;
}

// Start the renewal loop; returns a stopper that cancels it and resolves once the
// in-flight beat has settled.
export function startHeartbeat(config: HeartbeatConfig): () => Promise<void> {
  const intervalMs = Math.max(1, config.intervalMs);
  // The consecutive misses that exhaust the lease window — beyond this the reaper
  // may requeue a still-running job. At least 1 so a degenerate lease still trips.
  const atRiskThreshold = Math.max(1, Math.ceil(config.leaseMs / intervalMs));
  const onMiss = config.onMiss ?? defaultHeartbeatMissSink;
  const control = {
    running: true,
    inFlight: Promise.resolve(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    consecutiveMisses: 0,
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

  const schedule = (): void => {
    if (!control.running) {
      return;
    }
    control.timer = setTimeout(() => {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
