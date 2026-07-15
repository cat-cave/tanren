// AUDIT FINDING #6 (PR #711) + AUDIT FINDING D2 (writer-seam doctrine sweep):
// the review-kind task terminal routing. PR #711 made the row + `task.completed`
// atomic through `writer.updateTaskWithEvent` and routed the pre-terminal
// `review.*` event through the SAME writer surface, but those were still TWO
// separate transactions (the PR header admitted the deferral as "a future
// writer-seam extension"). The sweep delivers that extension — the writer-seam's
// `priorEvents` slot bundles the pre-terminal verdict into the SAME atomic
// transaction as the row + `task.completed`, so all three writes commit (or
// roll back) together.
//
// These tests pin:
//   1. exactly ONE writer.updateTaskWithEvent call (proving the 3 writes are
//      ONE transaction — the audit-D2 atomicity);
//   2. the pre-terminal `review.approved` / `review.changes_requested` event
//      rides on `priorEvents` (not a separate `writer.append()` call);
//   3. the terminal row + `task.completed` payload still match the prior
//      contract.
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
  orgId: "org_review_terminal",
  taskId: "task_review_terminal",
};

class RecordingWriter implements Pick<RunStateWriter, "updateTaskWithEvent" | "append"> {
  readonly appended: AppendEventInput[] = [];
  readonly atomic: UpdateTaskWithEventInput[] = [];

  async append(input: AppendEventInput): Promise<void> {
    this.appended.push(input);
  }

  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<{ alreadyTerminal: boolean }> {
    this.atomic.push(input);
    return { alreadyTerminal: false };
  }
}

describe("review task terminal routing (audit findings #6 + D2 — atomic 3-write)", () => {
  it("approved verdict: bundles review.approved into the SAME atomic transaction as the row + task.completed", async () => {
    const writer = new RecordingWriter();

    await markReviewTaskDoneWithEvent({
      writer: writer as unknown as RunStateWriter,
      base: BASE,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      reviewer: "alice",
    });

    // D2 atomicity proof: EXACTLY ONE writer.updateTaskWithEvent call carries
    // all three writes (the pre-terminal review.approved on priorEvents, the
    // row UPDATE, and the matching task.completed). The pre-terminal event is
    // NO LONGER on `writer.appended` — that was the pre-D2 split shape.
    expect(writer.appended).toEqual([]);
    expect(writer.atomic).toHaveLength(1);
    const call = writer.atomic[0]!;
    expect(call.task).toEqual({ taskId: BASE.taskId, transition: "done", outcome: "ok" });
    expect(call.event).toEqual({
      ...BASE,
      eventType: "task.completed",
      payload: { taskKind: "review", status: "approved" },
    });
    expect(call.priorEvents).toEqual([
      {
        ...BASE,
        eventType: "review.approved",
        payload: { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, reviewer: "alice" },
        // Round-3 H-R3.2: the prior-event entry carries a stable idempotency
        // key so a retried atomic write deduplicates the verdict event on
        // (run_id, idempotency_key) under `events_prior_idempotency_unique`.
        idempotencyKey: `${BASE.runId}:review:approved`,
      },
    ]);
  });

  it("approved + forge publication: binds forge id/state/url/head and head-bound idempotency key", async () => {
    const writer = new RecordingWriter();
    const headSha = "f".repeat(40);

    await markReviewTaskDoneWithEvent({
      writer: writer as unknown as RunStateWriter,
      base: BASE,
      verdict: "approved",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      reviewer: "reviewer-bot",
      forgePublication: {
        forgeReviewId: "9001",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
        headSha,
        reviewerLogin: "reviewer-bot",
      },
    });

    expect(writer.atomic).toHaveLength(1);
    expect(writer.atomic[0]!.priorEvents).toEqual([
      {
        ...BASE,
        eventType: "review.approved",
        payload: {
          prUrl: "https://github.com/o/r/pull/7",
          prNumber: 7,
          reviewer: "reviewer-bot",
          forgeReviewId: "9001",
          forgeReviewState: "approved",
          forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
          headSha,
        },
        // gv-2: forge receipt terminals key on run+verdict+head so re-review on a
        // replacement head can supersede without a second receipt store.
        idempotencyKey: `${BASE.runId}:review:approved:${headSha}`,
      },
    ]);
  });

  it("changes_requested verdict: bundles review.changes_requested (with feedback) into the SAME atomic transaction", async () => {
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

    expect(writer.appended).toEqual([]);
    expect(writer.atomic).toHaveLength(1);
    const call = writer.atomic[0]!;
    expect(call.priorEvents).toEqual([
      {
        ...BASE,
        eventType: "review.changes_requested",
        payload: {
          prUrl: "https://github.com/o/r/pull/7",
          prNumber: 7,
          reviewer: "carol",
          message: "fix the edge case",
        },
        idempotencyKey: `${BASE.runId}:review:changes_requested`,
      },
    ]);
    // changes_requested closes the task as done/ok (the verdict steers the writer
    // rework re-entry which opens its own writer tasks).
    expect(call.task).toEqual({ taskId: BASE.taskId, transition: "done", outcome: "ok" });
    expect(call.event).toEqual({
      ...BASE,
      eventType: "task.completed",
      payload: { taskKind: "review", status: "changes_requested" },
    });
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

    const prior = writer.atomic[0]!.priorEvents!;
    expect(prior).toHaveLength(1);
    const payload = prior[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ prUrl: "https://github.com/o/r/pull/7", prNumber: 7 });
    expect(payload).not.toHaveProperty("reviewer");
  });
});
