// AUDIT FINDING #6 — the review-kind task terminal pair. Mirrors
// `mergeTaskTerminalRouting.test.ts`: pin the writer-required signature + the
// atomic row + `task.completed` shape via `updateTaskWithEvent`, plus the
// pre-terminal `review.*` event routed through the SAME writer surface so all
// three writes flow through the writer seam.
import { describe, expect, it } from "vitest";
import type {
  AppendEventInput,
  RunStateWriter,
  UpdateTaskWithEventInput,
} from "../src/engine/contracts/runStateWriter.js";
import { markReviewTaskDoneWithEvent } from "../src/engine/workflow/reviewMerge/reviewTaskTerminal.js";

const BASE = {
  runId: "run_review_terminal",
  specId: "spec_review_terminal",
  projectId: "project_review_terminal",
  taskId: "task_review_terminal",
};

class RecordingWriter implements Pick<RunStateWriter, "updateTaskWithEvent" | "append"> {
  readonly appended: AppendEventInput[] = [];
  readonly updates: UpdateTaskWithEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    this.appended.push(input);
  }

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<{ alreadyTerminal: boolean }> {
    this.updates.push(input);
    return { alreadyTerminal: false };
  }
}

describe("review task terminal routing (audit finding #6)", () => {
  it("approved verdict: appends review.approved THEN commits row + task.completed atomically", async () => {
    const writer = new RecordingWriter();

    await markReviewTaskDoneWithEvent({
      writer: writer as unknown as RunStateWriter,
      base: BASE,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      reviewer: "alice",
    });

    // Pre-terminal review.approved appended via the writer surface.
    expect(writer.appended).toEqual([
      {
        ...BASE,
        eventType: "review.approved",
        payload: { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, reviewer: "alice" },
      },
    ]);
    // Atomic row + task.completed pair via updateTaskWithEvent (the §1c invariant).
    expect(writer.updates).toEqual([
      {
        task: { taskId: BASE.taskId, transition: "done", outcome: "ok" },
        event: {
          ...BASE,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" },
        },
      },
    ]);
  });

  it("changes_requested verdict: appends review.changes_requested with feedback THEN commits row + task.completed atomically", async () => {
    const writer = new RecordingWriter();

    await markReviewTaskDoneWithEvent({
      writer: writer as unknown as RunStateWriter,
      base: BASE,
      verdict: "changes_requested",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      reviewer: "carol",
      feedback: "fix the edge case",
    });

    expect(writer.appended).toEqual([
      {
        ...BASE,
        eventType: "review.changes_requested",
        payload: {
          prUrl: "https://github.com/o/r/pull/7",
          prNumber: 7,
          reviewer: "carol",
          message: "fix the edge case",
        },
      },
    ]);
    // changes_requested closes the task as done/ok (the verdict steers the writer
    // rework re-entry which opens its own writer tasks).
    expect(writer.updates).toEqual([
      {
        task: { taskId: BASE.taskId, transition: "done", outcome: "ok" },
        event: {
          ...BASE,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "changes_requested" },
        },
      },
    ]);
  });

  it("omits reviewer + feedback fields when undefined (no null placeholders in the payload)", async () => {
    const writer = new RecordingWriter();

    await markReviewTaskDoneWithEvent({
      writer: writer as unknown as RunStateWriter,
      base: BASE,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
    });

    const payload = writer.appended[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ prUrl: "https://github.com/o/r/pull/7", prNumber: 7 });
    expect(payload).not.toHaveProperty("reviewer");
  });
});
