import type { EventLog } from "./eventLog.js";
import type { MergeAuthorityRecorder, MergeSecurityAnomaly } from "./mergeAuthority.js";

export interface MergeRecorderContext {
  readonly pr: number;
  readonly headSha: string;
  readonly rubricVersion: string;
  readonly actor: string;
  readonly correlationId: string;
}

export class EventLogMergeRecorder implements MergeAuthorityRecorder {
  public constructor(
    private readonly events: EventLog,
    private readonly context: MergeRecorderContext,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async record(kind: "authorized" | "denied", reasons: readonly string[]): Promise<void> {
    await this.events.append({
      timestamp: this.now(),
      type: kind === "authorized" ? "merge_authorization" : "merge_denial",
      pr: this.context.pr,
      headSha: this.context.headSha,
      rubricVersion: this.context.rubricVersion,
      actor: this.context.actor,
      durationMs: 0,
      correlationId: this.context.correlationId,
      detail: { reasons },
    });
  }

  public async recordSecurityAnomaly(anomaly: MergeSecurityAnomaly): Promise<void> {
    await this.events.append({
      timestamp: this.now(),
      type: "security_anomaly",
      pr: this.context.pr,
      headSha: this.context.headSha,
      rubricVersion: this.context.rubricVersion,
      actor: this.context.actor,
      durationMs: 0,
      correlationId: this.context.correlationId,
      detail: {
        severity: "SECURITY ANOMALY",
        ...anomaly,
      },
    });
  }
}
