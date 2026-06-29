// AUDIT FINDING #5 — the merge-task terminal pair: writer is non-optional, the
// legacy no-writer split-write fallback is GONE. Tests pin the writer-required
// signature (the only path) — there is no longer a "preserves direct no-writer
// fallback" sister test because that path no longer exists in the helper.
import { describe, expect, it } from "vitest";
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

class RecordingWriter implements Pick<RunStateWriter, "updateTaskWithEvent"> {
  readonly updates: UpdateTaskWithEventInput[] = [];

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<{ alreadyTerminal: boolean }> {
    this.updates.push(input);
    return { alreadyTerminal: false };
  }
}

describe("merge task terminal routing (audit finding #5)", () => {
  it("routes merge task completion through updateTaskWithEvent (the SOLE atomic land path)", async () => {
    const writer = new RecordingWriter();

    await markMergeTaskDoneWithEvent({
      writer: writer as RunStateWriter,
      base: BASE,
      integration: "native_queue",
    });

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

  it("routes merge task failure through updateTaskWithEvent (the SOLE atomic land path)", async () => {
    const writer = new RecordingWriter();

    await markMergeTaskFailedWithEvent({
      writer: writer as RunStateWriter,
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
});
