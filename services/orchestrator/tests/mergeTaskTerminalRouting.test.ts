import { describe, expect, it } from "vitest";
import type { EventStore } from "../src/engine/eventStore.js";
import type { RunStateWriter, UpdateTaskWithEventInput } from "../src/engine/contracts/runStateWriter.js";
import {
  markMergeTaskDoneWithEvent,
  markMergeTaskFailedWithEvent,
} from "../src/engine/workflow/reviewMerge/mergeTaskTerminal.js";

const BASE = {
  runId: "run_merge_terminal",
  specId: "spec_merge_terminal",
  projectId: "project_merge_terminal",
  taskId: "task_merge_terminal",
};

class RecordingPool {
  readonly queries: { sql: string; params?: unknown[] }[] = [];

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
}

class RecordingEvents implements EventStore {
  readonly events: unknown[] = [];

  async append(input: never): Promise<void> {
    this.events.push(input);
  }
}

class RecordingWriter implements Pick<RunStateWriter, "updateTaskWithEvent"> {
  readonly updates: UpdateTaskWithEventInput[] = [];

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<{ alreadyTerminal: boolean }> {
    this.updates.push(input);
    return { alreadyTerminal: false };
  }
}

describe("merge task terminal routing", () => {
  it("routes merge task completion through updateTaskWithEvent when a writer is wired", async () => {
    const writer = new RecordingWriter();
    const pool = new RecordingPool();
    const events = new RecordingEvents();

    await markMergeTaskDoneWithEvent({
      writer: writer as RunStateWriter,
      pool,
      eventStore: events,
      base: BASE,
      integration: "native_queue",
    });

    expect(pool.queries).toEqual([]);
    expect(events.events).toEqual([]);
    expect(writer.updates).toEqual([
      {
        task: { taskId: BASE.taskId, transition: "done", outcome: "ok" },
        event: {
          ...BASE,
          eventType: "task.completed",
          payload: { taskKind: "merge", status: "native_queue" },
        },
      },
    ]);
  });

  it("routes merge task failure through updateTaskWithEvent when a writer is wired", async () => {
    const writer = new RecordingWriter();

    await markMergeTaskFailedWithEvent({
      writer: writer as RunStateWriter,
      pool: new RecordingPool(),
      eventStore: new RecordingEvents(),
      base: BASE,
      failureKind: "merge_failed",
    });

    expect(writer.updates).toEqual([
      {
        task: { taskId: BASE.taskId, transition: "failed_with_kind", failureKind: "merge_failed" },
        event: {
          ...BASE,
          eventType: "task.failed",
          payload: { taskKind: "merge", failureKind: "merge_failed" },
        },
      },
    ]);
  });

  it("preserves direct no-writer fallback for merge task completion", async () => {
    const pool = new RecordingPool();
    const events = new RecordingEvents();

    await markMergeTaskDoneWithEvent({
      pool,
      eventStore: events,
      base: BASE,
      integration: "direct_merge",
    });

    expect(pool.queries[0]?.sql).toContain("UPDATE tasks SET status = 'done'");
    expect(events.events).toEqual([
      {
        ...BASE,
        eventType: "task.completed",
        payload: { taskKind: "merge", status: "direct_merge" },
      },
    ]);
  });
});
