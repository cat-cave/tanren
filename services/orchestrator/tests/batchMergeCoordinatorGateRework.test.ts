// BatchMergeCoordinator — the batch-gate-fail self-heal (v35 — the strand fix).
//
// THE BUG: a spec authored work that passed its OWN per-iteration + pre-merge branch
// gates, opened a PR, got auto-approved + merge-queued. The native merge queue's BATCH
// check (the prospective MERGED/integrated tree gate) then FAILED on an integration-only
// failure (e.g. a config file not covered by the integrated tsconfig). Bisect blamed the
// culprit and the coordinator dequeued it with `reason: "conflict"` — but that has NO
// re-execution consumer (the recovery SQL only re-queues `blocked`), so the spec sat
// `in_flight` forever and the build could never converge.
//
// THE FIX (these tests): a GATE-fail bisect culprit is routed to the WRITER for REWORK
// (carrying the batch gate's failing output as steering) and the OLD entry is retired as
// `superseded` — distinct from a CONFLICT culprit (which is DRIVEN through the per-run
// conflict resolver, the never-discard re-drive). A culprit is handled by exactly ONE route.

import { describe, expect, it, vi } from "vitest";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
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

const PROJECT = "project_batch_gate_rework";

interface Harness {
  coordinator: BatchMergeCoordinator;
  queue: InMemoryMergeQueueModel;
  runner: ScriptedMergeRunner;
  checker: InMemoryBatchChecker;
  events: RecordingMergeQueueEventEmitter;
  batchEvents: RecordingBatchMergeEventEmitter;
  gateRework: RecordingBatchGateReworkRouter;
  evidence: ScriptedRecoveryEvidencePort;
  escalator: RecordingSpecEscalator;
}

function makeHarness(opts: { wireEvidence?: boolean } = {}): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const gateRework = new RecordingBatchGateReworkRouter();
  const evidence = new ScriptedRecoveryEvidencePort();
  const escalator = new RecordingSpecEscalator();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    gateRework,
    ...(opts.wireEvidence === false ? {} : { recoveryEvidence: evidence }),
    resolveMaxBatchSize: () => Promise.resolve(5),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, gateRework, evidence, escalator };
}

function seed(h: Harness, specId: string): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn: [], priority: "tbd" as SpecPriority });
}

/** Seed store proof for RecordingBatchGateReworkRouter's deterministic receipt ids. */
function seedWriterReworkEvidence(h: Harness, specId: string): void {
  h.evidence.seedEnqueued(specId, `run_rework_${specId}`, `task_rework_${specId}`, "queued");
}

describe("BatchMergeCoordinator — batch-gate-fail → writer rework (v35 strand fix)", () => {
  it("bisects a GATE-fail culprit, routes it to WRITER REWORK (carrying the gate error), retires it `superseded`, and merges the innocents", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // spec_c passes its OWN branch gates but the INTEGRATED tree's GATE fails (an
    // integration-only failure). The checker reports `result: "fail"` (gate, NOT conflict).
    seed(h, "spec_c");
    seed(h, "spec_d");
    h.checker.failWhenContains("spec_c");
    seedWriterReworkEvidence(h, "spec_c");
    const dequeueSpy = vi.spyOn(h.events, "emitDequeued");
    const culpritSpy = vi.spyOn(h.batchEvents, "emitCulprit");

    await h.coordinator.coordinate(PROJECT);

    // The culprit is isolated to EXACTLY spec_c.
    const culprit = h.batchEvents.events.find((e) => e.type === "culprit");
    expect(culprit?.culpritSpecId).toBe("spec_c");
    // THE FIX: the GATE-fail culprit is routed back to the WRITER for rework (carrying the
    // batch gate's failing output as steering) — NOT stranded / dequeued-without-rework.
    expect(h.gateRework.routed.map((r) => r.specId)).toEqual(["spec_c"]);
    expect(h.gateRework.routed[0]?.runId).toBe("run_spec_c");
    // The real gate error, not a blind rework.
    expect(h.gateRework.routed[0]?.gateError).toContain("spec_c");
    // The OLD entry retires as `superseded` (the re-authored run re-queues a fresh entry;
    // `superseded` is NOT re-queued by the recovery SQL, so the dead head cannot resurrect).
    // It is NOT `conflict` (that path has no re-execution consumer — the bug that stranded it).
    expect(h.queue.statusOf("run_spec_c")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.specId).toBe("spec_c");
    expect(dq?.reason).toBe("superseded");
    expect(culpritSpy.mock.invocationCallOrder[0]).toBeLessThan(dequeueSpy.mock.invocationCallOrder[0] ?? 0);
    // The culprit's drive was NEVER attempted (a failed-check batch never merges it).
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_c");

    // The innocent PRs merged (the batch was re-formed + re-checked without the culprit).
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_d")).toBe("merged");
  });

  it("a batch CONFLICT culprit is DRIVEN through the conflict resolver (never-discard) — NOT writer rework, NOT a bare dequeue (no regression on #585/#587)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b is a real spec-vs-spec integration CONFLICT (not a gate failure).
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    // The conflict culprit is DRIVEN through the per-run resolver (the default resolved outcome
    // merges it) — the never-discard re-drive, NOT the gate-rework writer path, and NOT a bare
    // `conflict` dequeue with no re-drive owner (the apex v95/v96 forever-stall).
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    // Never double-handled: a conflict is NOT a gate-rework.
    expect(h.gateRework.routed).toEqual([]);

    // The passing prefix lands before the culprit; the untouched suffix waits for the next pass.
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("queued");
    await h.coordinator.coordinate(PROJECT);
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
  });

  it("with NO gateRework router wired, a gate-fail culprit parks loudly instead of faking ownership", async () => {
    const queue = new InMemoryMergeQueueModel();
    const checker = new InMemoryBatchChecker();
    checker.failWhenContains("spec_b");
    const escalator = new RecordingSpecEscalator();
    const coordinator = new BatchMergeCoordinator({
      queue,
      runner: new ScriptedMergeRunner(),
      checker,
      events: new RecordingMergeQueueEventEmitter(),
      batchEvents: new RecordingBatchMergeEventEmitter(),
      escalator,
      // gateRework intentionally OMITTED.
      resolveMaxBatchSize: () => Promise.resolve(5),
      sleep: () => Promise.resolve(),
    });
    queue.seed({ runId: "run_spec_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    queue.seed({ runId: "run_spec_b", specId: "spec_b", dependsOn: [], priority: "tbd" });

    await coordinator.coordinate(PROJECT);

    expect(queue.statusOf("run_spec_b")).toBe("dequeued");
    expect(queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(escalator.escalations.map((entry) => entry.specId)).toEqual(["spec_b"]);
    expect(queue.statusOf("run_spec_a")).toBe("merged");
  });

  it("FAIL-CLOSED: gate-fail owned receipt without RecoveryEvidencePort parks (never mint-only supersede)", async () => {
    const h = makeHarness({ wireEvidence: false });
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.gateRework.routed.map((r) => r.specId)).toEqual(["spec_b"]);
    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(h.escalator.escalations[0]?.message).toMatch(/no RecoveryEvidencePort/u);
  });

  it("FAIL-CLOSED: gate-fail owned receipt with wrong planner task parks at settlement", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.failWhenContains("spec_b");
    // Seed wrong task id — structural mint matches router, store readback fails.
    h.evidence.seedEnqueued("spec_b", "run_rework_spec_b", "task_OTHER", "queued");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.dequeueReasonOf("run_spec_b")).toBe("needs_attention");
    expect(h.escalator.escalations[0]?.message).toMatch(/store readback/u);
  });
});
