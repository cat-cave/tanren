import { progressCycleReached } from "./stack-progress.js";
import { runCommand, type CommandEvidence } from "./stack-runtime.js";

export interface PreClaimObservation {
  targetQueueId: number;
  targetStatus: string | undefined;
  targetAttempts: number;
  targetHeartbeatAtMs: number | null;
  enqueuedAtMs: number;
  databaseNowMs: number;
  workerContainerId: string;
  workerRunning: boolean;
  workerStatus: string | undefined;
}

export interface ClaimMonitorOptions {
  expectedWorkerContainerId: string;
}

/**
 * Fail-closed pre-claim monitor. Convergence keys off target-specific durable
 * claim/finalization progress (status, attempts, heartbeat on the target row) plus
 * exact worker Running AND Status consistency. Concurrent later queue IDs are never
 * treated as progress for this target.
 */
export class WorkerClaimMonitor {
  private readonly signatures: string[] = [];

  constructor(private readonly options: ClaimMonitorOptions) {}

  observe(observation: PreClaimObservation): "queued" | "claimed" | "finalized" {
    if (observation.workerRunning !== true || observation.workerStatus !== "running") {
      throw new Error(
        `worker container not consistently running before claim ` +
          `(running=${String(observation.workerRunning)}, status=${String(observation.workerStatus)})`,
      );
    }
    if (observation.workerContainerId !== this.options.expectedWorkerContainerId) {
      throw new Error(
        `worker container was replaced before claim: expected ${this.options.expectedWorkerContainerId}, ` +
          `got ${observation.workerContainerId}`,
      );
    }
    const status = observation.targetStatus ?? "missing";
    if (status === "done" || status === "failed" || status === "cancelled" || status === "dead_letter") {
      if (observation.targetAttempts < 1) {
        throw new Error(`target queue ${observation.targetQueueId} finalized without a durable claim attempt`);
      }
      return "finalized";
    }
    if (status === "claimed" || status === "running" || status === "in_progress") {
      if (observation.targetAttempts < 1) {
        throw new Error(`target queue ${observation.targetQueueId} claims ${status} with zero attempts`);
      }
      return "claimed";
    }
    if (status !== "queued") {
      throw new Error(`target queue ${observation.targetQueueId} has unsupported status ${JSON.stringify(status)}`);
    }
    const signature = [
      status,
      String(observation.targetAttempts),
      String(observation.targetHeartbeatAtMs ?? "null"),
      observation.workerContainerId,
    ].join("|");
    this.signatures.push(signature);
    if (progressCycleReached(this.signatures)) {
      throw new Error(
        `worker remained running but made no target-specific durable claim progress ` +
          `(target queue id ${observation.targetQueueId}, status=${status}, ` +
          `attempts=${observation.targetAttempts}, heartbeat=${String(observation.targetHeartbeatAtMs)})`,
      );
    }
    return "queued";
  }
}

export async function inspectWorkerContainer(
  executable: string,
  expectedId: string,
  env: NodeJS.ProcessEnv,
  options: {
    cwd: string;
    signal: AbortSignal;
    onGroup: (pgid: number, state: "started" | "exited") => void;
    onSpawn?: (evidence: CommandEvidence) => void;
  },
): Promise<{ workerContainerId: string; workerRunning: boolean; workerStatus: string | undefined }> {
  const result = await runCommand(executable, ["inspect", expectedId, "--format", "{{json .State}}"], {
    cwd: options.cwd,
    env,
    capture: true,
    quiet: true,
    signal: options.signal,
    onGroup: options.onGroup,
    onSpawn: options.onSpawn,
  });
  const state = JSON.parse(result.stdout) as { Running?: unknown; Status?: unknown };
  const workerStatus = typeof state.Status === "string" ? state.Status : undefined;
  return {
    workerContainerId: expectedId,
    workerRunning: state.Running === true,
    workerStatus,
  };
}
