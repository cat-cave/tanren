// Test fixtures for SpecStatusReplanRouter routing suites (pool + enqueuer doubles).

import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import { SpecNotPreparedForRecoveryError } from "../../src/engine/workflow/specNotPreparedForRecoveryError.js";
import { SpecNotRunnableError } from "../../src/engine/workflow/projectSpecErrors.js";
import type { ReplanEnqueuer } from "../../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

/** Pool supporting runWithOrgScope (BEGIN/SET LOCAL/COMMIT) + active-owner SELECTs. */
export class RecordingPool {
  readonly statusWrites: Array<{ specId: string; status: string }> = [];
  readonly scopeOps: string[] = [];
  /** Live active owner runs for org-scoped proof. */
  liveRunsBySpec = new Map<string, { run_id: string; status: string }>();
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SET LOCAL")) {
      this.scopeOps.push(text);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE specs SET status")) {
      this.statusWrites.push({ specId: String(params?.[0]), status: String(params?.[1]) });
      return { rows: [] };
    }
    if (text.includes("FROM runs") && text.includes("status IN")) {
      const live = this.liveRunsBySpec.get(String(params?.[0]));
      if (live === undefined || !["queued", "running", "paused"].includes(live.status)) {
        return { rows: [] };
      }
      return { rows: [live] };
    }
    throw new Error(`unexpected pool query in replan-routing test: ${text}`);
  }
  async connect() {
    return { query: this.query.bind(this), release: () => {} };
  }
}

/** Enqueuer that refuses prepare for named specs (simulates terminal/missing). */
export class PrepareFailEnqueuer implements ReplanEnqueuer {
  readonly calls: Array<{ specId: string }> = [];
  constructor(
    private readonly reason: "missing" | "not_recoverable" = "not_recoverable",
    private readonly status = "merged",
  ) {}
  async enqueue(input: { specId: string }): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls.push({ specId: input.specId });
    throw new SpecNotPreparedForRecoveryError(input.specId, this.reason, this.status);
  }
}

/** Records the events the router appends (the timeline carrier). */
export class RecordingEventStore implements Pick<EventStore, "append"> {
  readonly events: AppendEventInput[] = [];
  async append(input: AppendEventInput): Promise<void> {
    this.events.push(input);
  }
}

/** Records the re-plan run enqueue (the never-discard re-author) — returns a fixed run id. */
export class RecordingEnqueuer implements ReplanEnqueuer {
  readonly calls: Array<{
    specId: string;
    orgId: string;
    projectId: string;
    steeringNote: string;
  }> = [];
  constructor(private readonly replanRunId = "run_replan_new") {}
  async enqueue(input: {
    specId: string;
    orgId: string;
    projectId: string;
    steeringNote: string;
  }): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls.push(input);
    return { replanRunId: this.replanRunId, plannerTaskId: `task_${this.replanRunId}` };
  }
}

/** An enqueuer that THROWS the benign already-claimed race (a concurrent tick took the spec). */
export class AlreadyClaimedEnqueuer implements ReplanEnqueuer {
  calls = 0;
  async enqueue(input: { specId: string }): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls += 1;
    throw new SpecNotRunnableError(input.specId, "in_flight");
  }
}
