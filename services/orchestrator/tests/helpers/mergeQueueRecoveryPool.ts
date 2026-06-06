import type pg from "pg";

interface QueueRow {
  queueId: string;
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
  prUrl: string | null;
  prNumber: string | null;
  status: "queued" | "merging" | "merged" | "dequeued";
  dequeueReason: "blocked" | "conflict" | "failed" | "superseded" | "needs_attention" | null;
  settledAt: Date | null;
}

interface EventRow {
  id?: number;
  projectId: string;
  orgId: string;
  runId: string | null;
  specId: string | null;
  eventType: string;
  ts: Date;
  payload: Record<string, unknown>;
}

export class QueueRecoveryPool {
  readonly projects = new Map<string, string>();
  readonly queue: QueueRow[] = [];
  readonly events: EventRow[] = [];
  private nextEventId = 1;
  private beforeWrite: (() => void) | undefined;

  seedProject(projectId: string, orgId: string): void {
    this.projects.set(projectId, orgId);
  }

  seedQueue(row: QueueRow): void {
    this.queue.push({ ...row });
  }

  seedEvent(row: EventRow): void {
    this.events.push({ ...row, id: this.nextEventId });
    this.nextEventId += 1;
  }

  beforeRecoveryWrite(callback: () => void): void {
    this.beforeWrite = callback;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (
      ["BEGIN", "COMMIT", "ROLLBACK", "LOCK TABLE merge_queue IN SHARE ROW EXCLUSIVE MODE"].includes(trimmed) ||
      trimmed.startsWith("SET LOCAL")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const orgId = this.projects.get(String(params[0]));
      return orgId === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: orgId }], rowCount: 1 };
    }
    if (trimmed.startsWith("WITH candidates AS")) {
      return { rows: [], rowCount: this.recover(String(params[0])) };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<QueueRecoveryPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  private recover(projectId: string): number {
    let count = 0;
    const candidates = this.queue
      .filter((row) => row.projectId === projectId)
      .filter((row) => row.status === "dequeued")
      .filter((row) => row.dequeueReason === "blocked")
      .filter((row) => row.prUrl !== null && row.prUrl !== "" && row.prNumber !== null)
      .filter((row) => !this.queue.some((active) => active !== row && active.runId === row.runId && isActive(active)))
      .filter((row) => hasRecoverableNativeDequeue(row, this.events))
      .filter((row) => !hasSuppressingSignal(row, this.events))
      .map((row) => ({
        row,
        dequeueReason: row.dequeueReason,
        prUrl: row.prUrl,
        prNumber: row.prNumber,
      }));
    this.beforeWrite?.();
    this.beforeWrite = undefined;
    for (const candidate of candidates) {
      const { row } = candidate;
      if (row.status !== "dequeued") continue;
      if (row.dequeueReason !== candidate.dequeueReason) continue;
      if (row.prUrl !== candidate.prUrl || row.prNumber !== candidate.prNumber) continue;
      if (this.queue.some((active) => active !== row && active.runId === row.runId && isActive(active))) continue;
      row.status = "queued";
      row.dequeueReason = null;
      row.settledAt = null;
      count += 1;
    }
    return count;
  }
}

function hasRecoverableNativeDequeue(row: QueueRow, events: EventRow[]): boolean {
  return events.some(
    (event) =>
      event.eventType === "merge.dequeued" &&
      event.payload["integration"] === "native_queue" &&
      event.payload["reason"] === "blocked" &&
      candidateSignalMatches(row, event, false),
  );
}

function hasSuppressingSignal(row: QueueRow, events: EventRow[]): boolean {
  return events.some((event) => isSuppressingSignal(event) && candidateSignalMatches(row, event, true));
}

function candidateSignalMatches(row: QueueRow, event: EventRow, includeSpecOnlySignals: boolean): boolean {
  if (event.projectId !== row.projectId || event.orgId !== row.orgId) return false;
  const eventPrUrl = stringValue(event.payload["prUrl"]);
  const eventPrNumber = stringValue(event.payload["prNumber"]);
  const eventRunId = stringValue(event.payload["runId"]);
  return (
    (event.runId !== null && event.runId === row.runId) ||
    eventRunId === row.runId ||
    (eventPrUrl !== null && eventPrUrl === row.prUrl) ||
    (eventPrNumber !== null && eventPrNumber === row.prNumber) ||
    membersMatch(row, event.payload["members"]) ||
    (includeSpecOnlySignals && isSpecOnlySignal(event.eventType) && event.specId === row.specId)
  );
}

function isSuppressingSignal(event: EventRow): boolean {
  if (event.eventType === "merge.batch.infra_blocked") return event.payload["terminal"] === true;
  return [
    "merge.completed",
    "merge.queue.infra_blocked",
    "merge.batch.culprit",
    "dag.spec.needs_attention",
    "dag.spec.percolation_replan",
    "merge.conflict.replan_routed",
    "recovery.replan_queued",
  ].includes(event.eventType);
}

function isSpecOnlySignal(eventType: string): boolean {
  return [
    "dag.spec.needs_attention",
    "dag.spec.percolation_replan",
    "merge.conflict.replan_routed",
    "recovery.replan_queued",
  ].includes(eventType);
}

function membersMatch(row: QueueRow, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((member) => {
    if (typeof member !== "object" || member === null) return false;
    const item = member as Record<string, unknown>;
    return stringValue(item["specId"]) === row.specId || stringValue(item["prNumber"]) === row.prNumber;
  });
}

function isActive(row: QueueRow): boolean {
  return row.status === "queued" || row.status === "merging";
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
