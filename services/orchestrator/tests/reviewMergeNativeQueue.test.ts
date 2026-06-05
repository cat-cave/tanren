// P2d (autonomy-engine.md §2d): the merge-stage behavior under the `native_queue`
// integration. The first run-loop pass ENTERS the ready run into Tanren's native
// merge queue (emits merge.queued, NEVER calls the merge API); the coordinator's
// DRIVE pass (`queueDrive: true`) runs the SAME directMerge path, labelled
// `native_queue`. `direct_merge` is proven UNCHANGED (it still merges immediately).

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun, type NativeQueueEnqueuer } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import { recordingMergeProbe, ReviewMergePool, unusedHttp } from "./reviewMerge.fixtures.js";

/** A recording native-queue enqueuer fake (tests/ only). */
function recordingEnqueuer(created = true): NativeQueueEnqueuer & {
  calls: { runId: string; specId: string; prNumber: number }[];
} {
  const calls: { runId: string; specId: string; prNumber: number }[] = [];
  const fn = (async (input) => {
    calls.push({ runId: input.runId, specId: input.specId, prNumber: input.prNumber });
    return { created };
  }) as NativeQueueEnqueuer & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("P2d native_queue merge stage", () => {
  it("ENTERS a ready run into the queue (merge.queued) and does NOT merge immediately", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });
    const enqueue = recordingEnqueuer(true);

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      enqueueNativeQueue: enqueue,
    });

    // The run entered the queue — it did NOT merge.
    expect(result.outcome).toBe("queued");
    expect(probe.mergeCalls).toBe(0);
    expect(enqueue.calls).toEqual([{ runId: "run_1", specId: "spec_1", prNumber: 7 }]);
    const queued = events.events.find((e) => e.eventType === "merge.queued");
    expect(queued?.payload).toMatchObject({ integration: "native_queue" });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(false);
  });

  it("is idempotent — a re-queue (created:false) emits NO second merge.queued", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });
    // The run is already queued (created:false).
    const enqueue = recordingEnqueuer(false);

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      enqueueNativeQueue: enqueue,
    });

    expect(result.outcome).toBe("queued");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.some((e) => e.eventType === "merge.queued")).toBe(false);
  });

  it("DRIVE pass (queueDrive) runs the real merge, labelled native_queue", async () => {
    const pool = new ReviewMergePool("native_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      merged: true,
      mergeSha: "merge-sha",
      conflict: false,
      status: 200,
      message: "merged",
    });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      queueDrive: true,
    });

    // The drive pass MERGES — the same directMerge path — and labels native_queue.
    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe("merge-sha");
    expect(probe.mergeCalls).toBe(1);
    const completed = events.events.find((e) => e.eventType === "merge.completed");
    expect(completed?.payload).toMatchObject({ integration: "native_queue", mergeSha: "merge-sha" });
    // AUDIT-EVIDENCE BASELINE: the terminal merge carries the governance policy
    // version + the initiating SERVICE actor. The fixture's reviewPolicy is `human`,
    // so a human APPROVER gated it — recorded as a generic human approving actor.
    expect(completed?.payload).toMatchObject({
      policyVersion: 1,
      initiatingActor: { kind: "service", id: "tanren-engine" },
      approvingActor: { kind: "human" },
    });
  });

  it("records NO approving actor on the AUTONOMOUS tier (reviewPolicy auto)", async () => {
    // The autonomous tier has no human verdict — the audit trail records that honestly
    // (no approving actor), distinct from the human tier above which records one.
    const pool = new ReviewMergePool("direct_merge", "open", "auto");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "s", conflict: false, status: 200, message: "m" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
    });

    expect(result.outcome).toBe("merged");
    const completed = events.events.find((e) => e.eventType === "merge.completed");
    expect(completed?.payload).toMatchObject({
      policyVersion: 1,
      initiatingActor: { kind: "service", id: "tanren-engine" },
    });
    // No human review gated this merge ⇒ no approving actor (an honest empty state).
    const completedPayload = completed!.payload as Record<string, unknown>;
    expect(completedPayload["approvingActor"]).toBeUndefined();
  });

  it("direct_merge is UNCHANGED — it merges immediately (no queue)", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      merged: true,
      mergeSha: "direct-sha",
      conflict: false,
      status: 200,
      message: "merged",
    });
    const enqueue = recordingEnqueuer(true);

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
      runId: "run_1",
      mergeProbe: probe,
      // Even with an enqueuer present, direct_merge ignores it and merges now.
      enqueueNativeQueue: enqueue,
    });

    expect(result.outcome).toBe("merged");
    expect(probe.mergeCalls).toBe(1);
    // Never queued under direct_merge.
    expect(enqueue.calls).toEqual([]);
    const completed = events.events.find((e) => e.eventType === "merge.completed");
    expect(completed?.payload).toMatchObject({ integration: "direct_merge" });
  });
});
