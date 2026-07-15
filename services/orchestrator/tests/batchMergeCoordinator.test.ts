import { describe, expect, it, vi } from "vitest";
import { MissingGithubCredentialRefError } from "../src/engine/credentials/githubTokenResolver.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { INFRA_HOLD_ALERT_RETRY_AFTER_MS } from "../src/engine/merge/batchInfraHoldCeiling.js";
import { RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
import type { SpecPriority } from "../src/engine/state/spec.js";
import {
  InMemoryBatchChecker,
  RecordingBatchGateReworkRouter,
  RecordingBatchMergeEventEmitter,
} from "./conformance/fakes/inMemoryBatchChecker.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { ScriptedRecoveryEvidencePort } from "./fixtures/scriptedRecoveryEvidence.js";

const PROJECT = "project_batch";

interface Harness {
  coordinator: BatchMergeCoordinator;
  queue: InMemoryMergeQueueModel;
  runner: ScriptedMergeRunner;
  checker: InMemoryBatchChecker;
  events: RecordingMergeQueueEventEmitter;
  batchEvents: RecordingBatchMergeEventEmitter;
  escalator: RecordingSpecEscalator;
  gateRework: RecordingBatchGateReworkRouter;
  evidence: ScriptedRecoveryEvidencePort;
}

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const gateRework = new RecordingBatchGateReworkRouter();
  const evidence = new ScriptedRecoveryEvidencePort();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    gateRework,
    recoveryEvidence: evidence,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework, evidence };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — speculative batch-check + bisect", () => {
  it("a passing batch merges every entry in DAG order (one combined check, no re-surprises)", async () => {
    const h = makeHarness();
    seed(h, "spec_a", []);
    seed(h, "spec_b", ["spec_a"]);
    seed(h, "spec_c", ["spec_b"]);

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toEqual(["run_spec_a", "run_spec_b", "run_spec_c"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
    expect(h.batchEvents.events.some((e) => e.type === "checking")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "passed")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  it("ESCALATES a needs_attention real-merge outcome to needs_attention (non-bricking, NOT the recoverable conflict path)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.runner.script("run_spec_b", {
      kind: "needs_attention",
      message: "irreconcilable with spec_z",
      parking: "required",
    });

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.escalator.escalations).toEqual([{ specId: "spec_b", message: "irreconcilable with spec_z" }]);
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("needs_attention");
  });

  it("an innocent PR is never blamed — only the unique pass→fail boundary is the culprit", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    const culprits = h.batchEvents.events.filter((e) => e.type === "culprit").map((e) => e.culpritSpecId);
    expect(culprits).toEqual(["spec_b"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
  });

  it("a failed-check batch NEVER merges to default_branch (no entry merges before a passing state)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.failWhenContains("spec_a");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_a");
  });

  it("bisect terminates and isolates the culprit even in a large batch (no infinite loop)", async () => {
    const h = makeHarness(16);
    for (let i = 0; i < 16; i += 1) seed(h, `spec_${i}`);
    h.checker.failWhenContains("spec_9");

    await expect(h.coordinator.coordinate(PROJECT)).resolves.toBeDefined();

    expect(h.queue.statusOf("run_spec_9")).toBe("dequeued");
    for (let i = 0; i < 16; i += 1) {
      if (i === 9) continue;
      expect(h.queue.statusOf(`run_spec_${i}`)).toBe("merged");
    }
  });

  it("respects the batch cap and logs it (no silent truncation)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = makeHarness(2);
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    seed(h, "spec_d");

    await h.coordinator.coordinate(PROJECT);

    const checking = h.batchEvents.events.find((e) => e.type === "checking");
    expect(checking?.specIds).toHaveLength(2);
    expect(checking?.capped).toBe(true);
    expect(checking?.eligibleCount).toBe(4);
    expect(checking?.maxBatchSize).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/batch CAPPED/u));
    logSpy.mockRestore();
  });

  it("holds (no merge, no bisect) when a merge is already in flight (serialization preserved)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    const snap = await h.queue.loadSnapshot(PROJECT);
    await h.queue.claim(snap.entries[0]!.queueId);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("serialized");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(h.checker.checked).toEqual([]);
  });

  it("holds when the batch CI is still pending — does NOT bisect a not-yet-terminal batch", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.mergedSpecId).toBeUndefined();
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
  });

  it("Bug B: a pending verdict returns a hold WITH retryAfterMs (default 15000 when no settle remainder)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    expect(result.retryAfterMs).toBe(15_000);
  });

  it("Bug B: a no-checks pending verdict wakes EXACTLY at the settle remainder (settleAfterMs)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.pendingWhenContains("spec_b");
    h.checker.pendingSettlesAfter(12_000);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    expect(result.retryAfterMs).toBe(12_000);
  });

  it("routes an integration-conflict batch through bisect, then DRIVES the culprit through the resolver (never-discard)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");

    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    await h.coordinator.coordinate(PROJECT);
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
  });

  it("holds on an empty queue (nothing to check)", async () => {
    const h = makeHarness();
    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("empty");
    expect(h.checker.checked).toEqual([]);
  });
});

describe("BatchMergeCoordinator — infra-error robustness (a thrown check NEVER dequeues a clean PR)", () => {
  it("HOLDS loudly on a PERSISTENT infra error: bounded retry, infra_blocked event, NO dequeue/blame", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.throwInfraAlways(new RefResetTransientError("HTTP 422 ref reset (transient)"));
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    const result = await h.coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    const blocked = h.batchEvents.events.find((e) => e.type === "infra_blocked");
    expect(blocked).toBeDefined();
    expect(blocked?.attempts).toBe(3);
    expect(h.checker.checked.length).toBe(2);
  });

  it("v54 #56: sustained infra escalation derives each dequeue reason from its typed rework receipt", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.throwInfraAlways(new RefResetTransientError("HTTP 504 (persistent gateway outage)"));

    const firstHold = await h.coordinator.coordinate(PROJECT);
    expect(firstHold.holdReason).toBe("infra_error");
    expect(firstHold.retryAfterMs).toBeGreaterThan(0);
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked" && e.terminal === true)).toBe(false);
    expect(h.gateRework.routed).toHaveLength(0);
    h.gateRework.escalateFor("spec_b");

    const last = await h.coordinator.coordinate(PROJECT);
    expect(last.holdReason).toBe("all_blocked");
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.queue.dequeueReasonOf("run_spec_a")).toBe("superseded");
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    const terminal = h.batchEvents.events.filter((e) => e.type === "infra_blocked" && e.terminal === true);
    expect(terminal).toHaveLength(1);
    expect(h.gateRework.routed).toHaveLength(2);
    expect(h.gateRework.routed[0]?.gateError).toContain("MERGE QUEUE WORKSPACE/INFRA FAILURE");
    expect(h.gateRework.routed[1]?.gateError).toContain("MERGE QUEUE WORKSPACE/INFRA FAILURE");
  });

  it("GAP #1: a SHIFTING infra hold keeps re-driving quietly — it never alerts terminally", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    let n = 0;
    h.checker.throwInfraFactory(() => new RefResetTransientError(`HTTP 504 variant ${n++}`));

    for (let i = 0; i < 4; i += 1) {
      const held = await h.coordinator.coordinate(PROJECT);
      expect(held.holdReason).toBe("infra_error");
      expect(h.queue.statusOf("run_spec_a")).toBe("queued");
      expect(h.batchEvents.events.some((e) => e.type === "infra_blocked" && e.terminal === true)).toBe(false);
    }
  });

  it("GAP #1: a recovering infra hold (transient then pass) RESETS the streak — it never reaches the terminal alert", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    h.checker.throwInfraForFirst(new RefResetTransientError("HTTP 504 (brief blip)"), 3);

    const held = await h.coordinator.coordinate(PROJECT);
    expect(held.holdReason).toBe("infra_error");
    expect(held.retryAfterMs).toBeGreaterThan(0);

    const merged = await h.coordinator.coordinate(PROJECT);
    expect(merged.holdReason).toBeUndefined();
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked" && e.terminal === true)).toBe(false);
  });

  it("a missing configured GitHub credential terminally blocks and dequeues in one pass", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.throwInfraAlways(
      new MissingGithubCredentialRefError("credential/github/org/org_1d8809c8-28d0-4cfa-ac11-9cdab65e542e/default"),
    );
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    const result = await h.coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("infra_blocked");
    expect(result.retryAfterMs).toBeUndefined();
    expect(h.checker.checked).toHaveLength(1);
    expect(dequeueSpy).toHaveBeenCalledTimes(2);
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(h.queue.dequeueReasonOf("run_spec_a")).toBe("blocked");
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("blocked");
    const terminal = h.batchEvents.events.filter((e) => e.type === "infra_blocked" && e.terminal === true);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.attempts).toBe(1);
    expect(terminal[0]?.consecutiveHolds).toBe(1);
    expect(terminal[0]?.message).toContain("missing GitHub credential ref");
    expect(h.batchEvents.events.filter((e) => e.type === "infra_blocked" && e.terminal !== true)).toHaveLength(0);

    const afterTerminal = await h.coordinator.coordinate(PROJECT);
    expect(afterTerminal.holdReason).toBe("empty");
    expect(h.batchEvents.events.filter((e) => e.type === "infra_blocked" && e.terminal === true)).toHaveLength(1);
  });

  it("a TRANSIENT infra error self-heals: throw once, then the retry passes and the batch merges", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.throwInfraForFirst(new RefResetTransientError("HTTP 422 (transient, self-heals)"), 1);
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(h.batchEvents.events.some((e) => e.type === "passed")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);
  });

  it("a transient real-merge drive throw releases the claim and holds, with no blocked dequeue", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RefResetTransientError('duplicate key value violates unique constraint "runners_pkey"');
    };

    const result = await h.coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("v54 #56: a SUSTAINED-identical real-merge drive throw ALSO escalates to writer rework (deterministic = spec defect)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RefResetTransientError("persistent resolver runner allocation outage");
    };

    const firstHold = await h.coordinator.coordinate(PROJECT);
    expect(firstHold.holdReason).toBe("infra_error");
    expect(firstHold.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);

    const last = await h.coordinator.coordinate(PROJECT);
    expect(last.holdReason).toBe("all_blocked");
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.gateRework.routed).toHaveLength(1);
    expect(h.gateRework.routed[0]?.gateError).toContain("MERGE QUEUE WORKSPACE/INFRA FAILURE");
    expect(INFRA_HOLD_ALERT_RETRY_AFTER_MS).toBeGreaterThan(0);
  });

  it("a GENUINE gate fail STILL bisects → culprit → routes to writer rework (no regression)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.specId).toBe("spec_b");
    expect(dq?.reason).toBe("superseded");
    expect(h.gateRework.routed.map((r) => r.specId)).toEqual(["spec_b"]);
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);
  });

  it("a GENUINE conflict bisects → culprit → DRIVEN through the resolver; a recoverable-conflict outcome retires the entry only after the resolver ran", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.conflictWhenContains("spec_b");
    h.evidence.seed("spec_b", { runId: "run_live", status: "running" });
    h.runner.script("run_spec_b", {
      kind: "conflict",
      message: "resolver routed a bounded replan",
      recovery: { kind: "planner_replan", specId: "spec_b", run: { kind: "already_running", runId: "run_live" } },
    });

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.reason).toBe("conflict");
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);
  });
});
