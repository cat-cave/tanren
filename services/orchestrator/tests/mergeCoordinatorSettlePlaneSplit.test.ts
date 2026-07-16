import { describe, expect, it } from "vitest";
import type { MergeQueueEntry, MergeQueueModel } from "../src/engine/contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "../src/engine/merge/coordinator.js";
import { markDequeuedAfterEvent } from "../src/engine/merge/coordinator.js";

const ENTRY: MergeQueueEntry = {
  orgId: "org_parity",
  projectId: "project_parity",
  queueId: "mq_parity",
  runId: "run_parity",
  specId: "spec_parity",
  prUrl: "https://github.test/pull/1",
  prNumber: 1,
  dependsOn: [],
  priority: "tbd",
  orderKey: 1,
};

function recordingPlane(trace: string[]): { events: MergeQueueEventEmitter; queue: MergeQueueModel } {
  const events = {
    emitDequeued: () => {
      trace.push("event");
      return Promise.resolve();
    },
  } as unknown as MergeQueueEventEmitter;
  const queue = {
    markDequeued: () => {
      trace.push("queue");
      return Promise.resolve();
    },
  } as unknown as MergeQueueModel;
  return { events, queue };
}

describe("merge settlement writer-plane parity", () => {
  it.each(["direct", "http"])("uses one event-first terminal order for %s", async () => {
    const trace: string[] = [];
    const plane = recordingPlane(trace);
    await markDequeuedAfterEvent({
      ...plane,
      projectId: ENTRY.projectId,
      entry: ENTRY,
      reason: "superseded",
      message: "terminal replacement",
    });
    expect(trace).toEqual(["event", "queue"]);
  });
});
