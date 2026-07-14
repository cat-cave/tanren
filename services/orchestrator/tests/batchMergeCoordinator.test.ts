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
}

function makeHarness(maxBatchSize = 5): Harness {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const gateRework = new RecordingBatchGateReworkRouter();
  const coordinator = new BatchMergeCoordinator({
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    gateRework,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
    // Run the bounded infra-error retries instantly (no real backoff in tests).
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework };
}

function seed(h: Harness, specId: string, dependsOn: string[] = [], priority: SpecPriority = "tbd"): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn, priority });
}

describe("BatchMergeCoordinator — speculative batch-check + bisect", () => {
  it("a passing batch merges every entry in DAG order (one combined check, no re-surprises)", async () => {
    const h = makeHarness();
    // A chain A→B→C plus an independent D — all in one batch, the check passes.
    seed(h, "spec_a", []);
    seed(h, "spec_b", ["spec_a"]);
    seed(h, "spec_c", ["spec_b"]);

    await h.coordinator.coordinate(PROJECT);

    // Every entry merged, in DAG order (ancestor before dependent).
    expect(h.runner.drives.map((d) => d.runId)).toEqual(["run_spec_a", "run_spec_b", "run_spec_c"]);
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    expect(h.queue.statusOf("run_spec_c")).toBe("merged");
    // The batch was checked ONCE as a combined unit, then passed.
    expect(h.batchEvents.events.some((e) => e.type === "checking")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "passed")).toBe(true);
    expect(h.batchEvents.events.some((e) => e.type === "bisecting")).toBe(false);
  });

  // The gate-fail → writer-rework bisect routing + the conflict-vs-gate-fail distinction
  // live in batchMergeCoordinatorGateRework.test.ts (the v35 strand fix).

  it("ESCALATES a needs_attention real-merge outcome to needs_attention (non-bricking, NOT the recoverable conflict path)", async () => {
    const h = makeHarness();
    // The batch check PASSES, but spec_b's REAL merge drive returns the genuinely-
    // irreconcilable `needs_attention` outcome (the resolver's verdict the speculative
    // check could not see). It must PARK at needs_attention, never re-execute.
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.runner.script("run_spec_b", { kind: "needs_attention", message: "irreconcilable with spec_z" });

    await h.coordinator.coordinate(PROJECT);

    // spec_a (driven first, DAG order) merged; spec_b is ESCALATED + dequeued
    // `needs_attention` — the batch STOPS (no dependent merges past the parked spec).
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    // The spec was parked at needs_attention via the shared escalator (the loud event).
    expect(h.escalator.escalations).toEqual([{ specId: "spec_b", message: "irreconcilable with spec_z" }]);
    // Dequeued with the TERMINAL needs_attention reason — NOT the recoverable conflict.
    const dq = h.events.events.find((e) => e.type === "merge.dequeued" && e.specId === "spec_b");
    expect(dq?.reason).toBe("needs_attention");
  });

  it("an innocent PR is never blamed — only the unique pass→fail boundary is the culprit", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b is the only bad-interaction PR.
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
    // EVERY entry contains the bad spec only as the whole-batch interaction: mark spec_a
    // bad so the FULL batch fails AND every prefix containing it fails — the only
    // passing prefix is the empty base. No innocent precedes the culprit.
    // spec_a is bad AND at the head, so no innocent precedes the culprit.
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.failWhenContains("spec_a");

    await h.coordinator.coordinate(PROJECT);

    // spec_a is the culprit (dequeued), spec_b (innocent) merges; spec_a never merged.
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");
    // spec_a's real merge was never driven.
    expect(h.runner.drives.map((d) => d.runId)).not.toContain("run_spec_a");
  });

  it("bisect terminates and isolates the culprit even in a large batch (no infinite loop)", async () => {
    const h = makeHarness(16);
    for (let i = 0; i < 16; i += 1) seed(h, `spec_${i}`);
    h.checker.failWhenContains("spec_9");

    // A real timer guards against a hang — the pass must complete promptly.
    await expect(h.coordinator.coordinate(PROJECT)).resolves.toBeDefined();

    expect(h.queue.statusOf("run_spec_9")).toBe("dequeued");
    // Every other entry merged.
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

    // The first checking event saw a capped batch of 2 of 4 eligible.
    const checking = h.batchEvents.events.find((e) => e.type === "checking");
    expect(checking?.specIds).toHaveLength(2);
    expect(checking?.capped).toBe(true);
    expect(checking?.eligibleCount).toBe(4);
    expect(checking?.maxBatchSize).toBe(2);
    // The cap was LOGGED (operator visibility — no silent truncation).
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/batch CAPPED/u));
    logSpy.mockRestore();
  });

  it("holds (no merge, no bisect) when a merge is already in flight (serialization preserved)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // Simulate another entry already claimed (merging) — the serialization signal.
    const snap = await h.queue.loadSnapshot(PROJECT);
    await h.queue.claim(snap.entries[0]!.queueId);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("serialized");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    // No batch check ran (nothing was formed while a merge is in flight).
    expect(h.checker.checked).toEqual([]);
  });

  it("holds when the batch CI is still pending — does NOT bisect a not-yet-terminal batch", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    // No entry merged or dequeued — the pass held for CI to settle (no false blame).
    expect(result.mergedSpecId).toBeUndefined();
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
  });

  it("Bug B: a pending verdict returns a hold WITH retryAfterMs (default 15000 when no settle remainder)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // A registered-CI pending (no settleAfterMs) → the default recheck interval.
    h.checker.pendingWhenContains("spec_b");

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    // The hold carries a backoff so the subscriber arms one timer instead of hot-looping.
    expect(result.retryAfterMs).toBe(15_000);
  });

  it("Bug B: a no-checks pending verdict wakes EXACTLY at the settle remainder (settleAfterMs)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    // The no-checks settle: 12s remaining of the grace.
    h.checker.pendingWhenContains("spec_b");
    h.checker.pendingSettlesAfter(12_000);

    const result = await h.coordinator.coordinate(PROJECT);
    expect(result.holdReason).toBe("all_blocked");
    // retryAfterMs == the settle remainder so the re-drive fires exactly at expiry.
    expect(result.retryAfterMs).toBe(12_000);
  });

  it("routes an integration-conflict batch through bisect, then DRIVES the culprit through the resolver (never-discard)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // spec_b conflicts on the integration ref (an A-vs-B build conflict).
    seed(h, "spec_b");
    seed(h, "spec_c");
    h.checker.conflictWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    // The culprit is bisected then DRIVEN through the per-run resolver (default resolved → merged)
    // — never a bare `conflict` dequeue with no re-drive owner.
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("merged");

    // The passing prefix lands before the culprit; only the untouched suffix waits for the next pass.
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
    // The check THROWS a transient infra error on EVERY attempt (the live 422 repro).
    h.checker.throwInfraAlways(new RefResetTransientError("HTTP 422 ref reset (transient)"));
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    const result = await h.coordinator.coordinate(PROJECT);

    // The pass HELD on infra_error — never merged, never dequeued.
    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    // The clean PRs are STILL queued — neither was blamed/dequeued.
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.queue.statusOf("run_spec_b")).toBe("queued");
    // markDequeued was NEVER called; no culprit/dequeue event fired.
    expect(dequeueSpy).not.toHaveBeenCalled();
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(false);
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
    // The LOUD infra_blocked event fired with the telemetry attempt count.
    const blocked = h.batchEvents.events.find((e) => e.type === "infra_blocked");
    expect(blocked).toBeDefined();
    // The emitted `attempts` is the HELD_AFTER_ATTEMPTS telemetry constant (observability),
    // NOT a control-flow trigger.
    expect(blocked?.attempts).toBe(3);
    // The in-pass loop re-polled while the failure might shift, then handed off the moment the
    // IDENTICAL infra error recurred (an in-pass fixed point — no progress): 2 checks, not forever.
    expect(h.checker.checked.length).toBe(2);
  });

  it("v54 #56: a SUSTAINED-identical retriable infra hold ESCALATES the batch to writer rework + dequeues superseded", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.throwInfraAlways(new RefResetTransientError("HTTP 504 (persistent gateway outage)"));

    // First cross-pass hold: recoverable (one hold is not yet proof of non-recovery).
    const firstHold = await h.coordinator.coordinate(PROJECT);
    expect(firstHold.holdReason).toBe("infra_error");
    expect(firstHold.retryAfterMs).toBeGreaterThan(0);
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked" && e.terminal === true)).toBe(false);
    expect(h.gateRework.routed).toHaveLength(0);

    // The re-drive hits the IDENTICAL failure with no progress → ESCALATE: every batch
    // member routes to writer rework + the queue entry is dequeued `superseded`. The
    // re-authored run re-queues a fresh entry; recovery remains autonomous through the
    // writer path, not the queue's soft-loop.
    const last = await h.coordinator.coordinate(PROJECT);
    expect(last.holdReason).toBe("all_blocked");
    expect(h.queue.statusOf("run_spec_a")).toBe("dequeued");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const terminal = h.batchEvents.events.filter((e) => e.type === "infra_blocked" && e.terminal === true);
    expect(terminal).toHaveLength(1);
    // The writer rework primitive received one routing call per member, each carrying the
    // batch's bootstrap/infra failure as steering.
    expect(h.gateRework.routed).toHaveLength(2);
    expect(h.gateRework.routed[0]?.gateError).toContain("MERGE QUEUE WORKSPACE/INFRA FAILURE");
    expect(h.gateRework.routed[1]?.gateError).toContain("MERGE QUEUE WORKSPACE/INFRA FAILURE");
  });

  it("GAP #1: a SHIFTING infra hold keeps re-driving quietly — it never alerts terminally", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // Each pass throws a DIFFERENT transient (a recovering / shifting outage): progress.
    let n = 0;
    h.checker.throwInfraFactory(() => new RefResetTransientError(`HTTP 504 variant ${n++}`));

    for (let i = 0; i < 4; i += 1) {
      const held = await h.coordinator.coordinate(PROJECT);
      expect(held.holdReason).toBe("infra_error");
      expect(h.queue.statusOf("run_spec_a")).toBe("queued");
      // A shifting failure is progress — it must NEVER emit the terminal non-recovery alert.
      expect(h.batchEvents.events.some((e) => e.type === "infra_blocked" && e.terminal === true)).toBe(false);
    }
  });

  it("GAP #1: a recovering infra hold (transient then pass) RESETS the streak — it never reaches the terminal alert", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    // Throw the IDENTICAL infra on the first pass (re-polled in-pass, then handed off + held
    // ONCE), then self-heal so the next pass passes + merges. The streak resets on the passing
    // verdict — the sustained-non-recovery alert is never reached.
    h.checker.throwInfraForFirst(new RefResetTransientError("HTTP 504 (brief blip)"), 3);

    const held = await h.coordinator.coordinate(PROJECT);
    expect(held.holdReason).toBe("infra_error");
    expect(held.retryAfterMs).toBeGreaterThan(0);

    const merged = await h.coordinator.coordinate(PROJECT);
    expect(merged.holdReason).toBeUndefined();
    expect(h.queue.statusOf("run_spec_a")).toBe("merged");
    // It never escalated to a terminal halt.
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
    // Throw the transient infra error ONCE; the next check succeeds.
    h.checker.throwInfraForFirst(new RefResetTransientError("HTTP 422 (transient, self-heals)"), 1);
    const dequeueSpy = vi.spyOn(h.queue, "markDequeued");

    await h.coordinator.coordinate(PROJECT);

    // Both clean PRs merged after the retry; no dequeue, no infra hold.
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

  // task #21A's `RunnerClaimLiveRowError` doctrine-alignment proof (typed
  // `retriable: false` routes to `merge_retry`, not the apex-v49 `infra_error`
  // hot-loop) lives in `batchMergeCoordinatorRunnerClaimLiveRow.test.ts`.
  it("v54 #56: a SUSTAINED-identical real-merge drive throw ALSO escalates to writer rework (deterministic = spec defect)", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    h.runner.driveMerge = async (input) => {
      h.runner.drives.push({ runId: input.runId });
      throw new RefResetTransientError("persistent resolver runner allocation outage");
    };

    // First pass: a recoverable hold (one throw is not yet proof of non-recovery).
    const firstHold = await h.coordinator.coordinate(PROJECT);
    expect(firstHold.holdReason).toBe("infra_error");
    expect(firstHold.retryAfterMs).toBeGreaterThan(0);
    expect(h.queue.statusOf("run_spec_a")).toBe("queued");
    expect(h.events.events.some((e) => e.type === "merge.dequeued")).toBe(false);

    // The re-drive hits the IDENTICAL throw with no progress → escalate to writer rework.
    // A sustained-identical drive throw IS deterministic and is treated as a spec defect
    // (the same primitive as a gate-fail bisect culprit), not as transient infra.
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
    // A genuine GATE failure (the check RETURNS fail, it does not throw) must still bisect
    // AND route the culprit to writer rework (the integrated-tree gate-fail self-heal).
    h.checker.failWhenContains("spec_b");

    await h.coordinator.coordinate(PROJECT);

    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.specId).toBe("spec_b");
    // A gate-fail culprit retires as `superseded` (the re-authored run re-queues) + is
    // routed to writer rework — NOT the recoverable-conflict dequeue.
    expect(dq?.reason).toBe("superseded");
    expect(h.gateRework.routed.map((r) => r.specId)).toEqual(["spec_b"]);
    expect(h.batchEvents.events.some((e) => e.type === "culprit")).toBe(true);
    // No infra hold on a genuine failure.
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);
  });

  it("a GENUINE conflict bisects → culprit → DRIVEN through the resolver; a recoverable-conflict outcome retires the entry only after the resolver ran", async () => {
    const h = makeHarness();
    seed(h, "spec_a");
    seed(h, "spec_b");
    h.checker.conflictWhenContains("spec_b");
    // The per-run resolver routed a bounded replan → the recoverable `conflict` drive outcome.
    // Retiring the entry is correct BECAUSE the resolver actually ran (re-opened the spec +
    // enqueued a fresh run) — unlike the old bare dequeue that had NO re-drive owner.
    h.runner.script("run_spec_b", { kind: "conflict", message: "resolver routed a bounded replan" });

    await h.coordinator.coordinate(PROJECT);

    expect(h.runner.drives.map((d) => d.runId)).toContain("run_spec_b");
    expect(h.queue.statusOf("run_spec_b")).toBe("dequeued");
    const dq = h.events.events.find((e) => e.type === "merge.dequeued");
    expect(dq?.reason).toBe("conflict");
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);
  });
});
