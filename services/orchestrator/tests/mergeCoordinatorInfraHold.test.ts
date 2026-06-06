// GitHub-5xx resilience (GAP #2d): the EventEmittingMergeCoordinator must NOT strand a
// clean PR when the merge DRIVE THROWS a transient/infra error. A `done` run never
// re-readies, so the old `markDequeued("blocked")` permanently stranded a mergeable PR.
// These prove driveAndSettle:
//   - a THROWN transient/infra error (untyped, RefResetTransientError, or the merge-PUT
//     MergeTransientError) → RELEASES the claim back to `queued` (entry STAYS queued),
//     holds with `holdReason: "infra_error"` + `retryAfterMs`, emits NO dequeue;
//   - it RECOVERS: a later re-drive that returns `merged` merges the entry;
//   - it is BOUNDED: after MAX_INFRA_HOLD_ATTEMPTS consecutive infra throws it emits a
//     LOUD merge.queue.infra_blocked (kind ceiling), keeps the entry queued, and backs
//     off so recovery remains autonomous without hot-looping;
//   - a MergeAmbiguousError → a LOUD infra_blocked (kind ambiguous) + dequeue, NO
//     re-drive (never re-PUT — could double-merge);
//   - a THROWN typed-PERMANENT infra error / returned block or conflict → releases
//     the claim with bounded merge_retry backoff instead of stranding the candidate.

import { describe, expect, it, vi } from "vitest";
import type { MergeDriveOutcome, MergeRunner } from "../src/engine/contracts/mergeCoordinator.js";
import { EventEmittingMergeCoordinator } from "../src/engine/merge/coordinator.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../src/engine/credentials/githubTokenResolver.js";
import { RefResetPermanentError, RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
import { MergeAmbiguousError, MergeTransientError } from "../src/engine/providers/mergeOutcomeErrors.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
} from "./conformance/fakes/inMemoryMergeQueue.js";

/**
 * A merge runner that THROWS a scripted error for a given run id (the drive failing).
 * `throwFor` throws the same error on every drive; `throwTimesThen` throws a bounded
 * number of times then returns a scripted outcome (the recover-after-blip case).
 */
class ThrowingMergeRunner implements MergeRunner {
  readonly drives: { runId: string }[] = [];
  private readonly thrown = new Map<string, unknown>();
  private readonly returned = new Map<string, MergeDriveOutcome>();
  private readonly throwBudget = new Map<string, { error: unknown; times: number; thenReturn: MergeDriveOutcome }>();
  private readonly throwCounts = new Map<string, number>();

  throwFor(runId: string, error: unknown): void {
    this.thrown.set(runId, error);
  }
  returnFor(runId: string, outcome: MergeDriveOutcome): void {
    this.returned.set(runId, outcome);
  }
  throwTimesThen(runId: string, error: unknown, times: number, thenReturn: MergeDriveOutcome): void {
    this.throwBudget.set(runId, { error, times, thenReturn });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async driveMerge(input: { runId: string; projectId: string }): Promise<MergeDriveOutcome> {
    this.drives.push({ runId: input.runId });
    const budget = this.throwBudget.get(input.runId);
    if (budget !== undefined) {
      const seen = this.throwCounts.get(input.runId) ?? 0;
      if (seen < budget.times) {
        this.throwCounts.set(input.runId, seen + 1);
        throw budget.error;
      }
      return budget.thenReturn;
    }
    if (this.thrown.has(input.runId)) throw this.thrown.get(input.runId);
    return this.returned.get(input.runId) ?? { kind: "merged", mergeSha: `sha_${input.runId}` };
  }
}

const PROJECT = "project_infra";

function harness(): {
  queue: InMemoryMergeQueueModel;
  runner: ThrowingMergeRunner;
  events: RecordingMergeQueueEventEmitter;
  coordinator: EventEmittingMergeCoordinator;
} {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ThrowingMergeRunner();
  const events = new RecordingMergeQueueEventEmitter();
  const coordinator = new EventEmittingMergeCoordinator({
    queue,
    runner,
    events,
    escalator: new RecordingSpecEscalator(),
  });
  return { queue, runner, events, coordinator };
}

describe("EventEmittingMergeCoordinator — transient merge-drive throw → infra-hold (no strand)", () => {
  it("an UNTYPED thrown error → releases the claim (entry stays queued) + infra_error hold, no dequeue", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_a", specId: "spec_a", dependsOn: [], priority: "tbd" });
    // A bare thrown error (e.g. a raw 504-bearing Error from the merge stage) defaults
    // to retriable — the safe choice (it never strands a clean PR).
    runner.throwFor("run_a", new Error("merge drive failed: HTTP 504 Gateway Timeout"));

    const result = await coordinator.coordinate(PROJECT);

    // HELD on infra_error with a re-drive delay — NOT dequeued.
    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.dequeuedSpecId).toBeUndefined();
    // The entry is back in the queue (released claim) — the subscriber re-drive re-picks it.
    expect(queue.statusOf("run_a")).toBe("queued");
    // No merge.dequeued was emitted (the PR was never blamed/stranded).
    expect(events.events.filter((e) => e.type === "merge.dequeued")).toEqual([]);
  });

  it("a typed RefResetTransientError → same infra-hold (released + queued, no dequeue)", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_b", specId: "spec_b", dependsOn: [], priority: "tbd" });
    runner.throwFor("run_b", new RefResetTransientError("ref reset force-update hit a transient HTTP 504"));

    const result = await coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("infra_error");
    expect(queue.statusOf("run_b")).toBe("queued");
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("a MergeTransientError (persistent merge-PUT, confirmed open+unmerged) → infra-hold, NOT merge.failed (GAP #2d)", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_t", specId: "spec_t", dependsOn: [], priority: "tbd" });
    // The merge PUT exhausted its re-PUTs but confirmed the PR is still open+unmerged —
    // the OLD code returned {merged:false,conflict:false} → merge.failed → terminal dequeue.
    runner.throwFor("run_t", new MergeTransientError("merge PUT persistent 504; PR confirmed open + unmerged"));

    const result = await coordinator.coordinate(PROJECT);

    // Held for re-drive, NOT dequeued/failed — the clean PR is no longer stranded.
    expect(result.holdReason).toBe("infra_error");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.dequeuedSpecId).toBeUndefined();
    expect(queue.statusOf("run_t")).toBe("queued");
    expect(events.events.some((e) => e.type === "merge.dequeued" || e.type === "merge.queue.infra_blocked")).toBe(
      false,
    );
  });

  it("RECOVERS: an infra-hold then a later re-drive returning merged → the entry merges", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_r", specId: "spec_r", dependsOn: [], priority: "tbd" });
    // Throw a transient ONCE (the GitHub blip), then the next re-drive merges.
    runner.throwTimesThen("run_r", new MergeTransientError("transient 504"), 1, {
      kind: "merged",
      mergeSha: "deadbeef",
    });

    // First pass: infra-hold (entry stays queued).
    const held = await coordinator.coordinate(PROJECT);
    expect(held.holdReason).toBe("infra_error");
    expect(queue.statusOf("run_r")).toBe("queued");

    // The subscriber's delayed re-drive: a second coordinate pass now merges.
    const merged = await coordinator.coordinate(PROJECT);
    expect(merged.mergedSpecId).toBe("spec_r");
    expect(queue.statusOf("run_r")).toBe("merged");
    expect(events.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(false);
  });

  it("BOUNDED: after MAX_INFRA_HOLD_ATTEMPTS consecutive infra throws → LOUD infra_blocked (ceiling) + queued backoff", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_x", specId: "spec_x", dependsOn: [], priority: "tbd" });
    // A persistent outage: every re-drive throws transient.
    runner.throwFor("run_x", new MergeTransientError("persistent 504"));

    // Drive repeatedly (simulating the subscriber's re-drive timer). The first 4 passes
    // hold on the short retry; the 5th hits the ceiling (MAX_INFRA_HOLD_ATTEMPTS = 5)
    // → loud alert + longer backoff, while the entry remains queued.
    for (let i = 0; i < 4; i += 1) {
      const held = await coordinator.coordinate(PROJECT);
      expect(held.holdReason).toBe("infra_error");
      expect(queue.statusOf("run_x")).toBe("queued");
      expect(events.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(false);
    }
    const alerted = await coordinator.coordinate(PROJECT);

    // The ceiling fired: a LOUD alert, the entry stays queued, and the subscriber keeps
    // autonomous recovery alive on a slower timer instead of creating a permanent block.
    expect(alerted.dequeuedSpecId).toBeUndefined();
    expect(alerted.holdReason).toBe("infra_error");
    expect(alerted.retryAfterMs).toBe(60_000);
    expect(queue.statusOf("run_x")).toBe("queued");
    const blocked = events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.kind).toBe("ceiling");
    expect(blocked[0]?.attempts).toBe(5);
    // It never wrongly emitted a recoverable merge.dequeued for the infra blips.
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("a MergeAmbiguousError → LOUD infra_blocked (ambiguous) + dequeue, NO re-drive (never double-merge)", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_m", specId: "spec_m", dependsOn: [], priority: "tbd" });
    runner.throwFor("run_m", new MergeAmbiguousError("merge state unconfirmable after a 504"));

    const result = await coordinator.coordinate(PROJECT);

    // A loud halt the FIRST time — no hold, no re-drive (auto-retry could double-merge).
    expect(result.holdReason).toBeUndefined();
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.dequeuedSpecId).toBe("spec_m");
    expect(queue.statusOf("run_m")).toBe("dequeued");
    const blocked = events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.kind).toBe("ambiguous");
    // The drive ran exactly ONCE — never re-driven (the double-merge risk).
    expect(runner.drives.filter((d) => d.runId === "run_m")).toHaveLength(1);
  });

  it("keeps a conflict claim active when merge.dequeued append fails before settlement", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_split", specId: "spec_split", dependsOn: [], priority: "tbd" });
    runner.returnFor("run_split", { kind: "conflict", message: "resolver routed replan" });
    vi.spyOn(events, "emitDequeued").mockRejectedValueOnce(new Error("event store unavailable"));

    await expect(coordinator.coordinate(PROJECT)).rejects.toThrow("event store unavailable");

    expect(queue.statusOf("run_split")).toBe("merging");
  });

  it("keeps an ambiguous merge claim active when infra-blocked append fails before settlement", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_ambiguous_split", specId: "spec_ambiguous_split", dependsOn: [], priority: "tbd" });
    runner.throwFor("run_ambiguous_split", new MergeAmbiguousError("merge state unconfirmable"));
    vi.spyOn(events, "emitInfraBlocked").mockRejectedValueOnce(new Error("event store unavailable"));

    await expect(coordinator.coordinate(PROJECT)).rejects.toThrow("event store unavailable");

    expect(queue.statusOf("run_ambiguous_split")).toBe("merging");
  });

  it("a typed RefResetPermanentError → bounded merge_retry hold, not a stranded dequeue", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_c", specId: "spec_c", dependsOn: [], priority: "tbd" });
    runner.throwFor("run_c", new RefResetPermanentError("ref force-update failed: HTTP 404"));

    const result = await coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("merge_retry");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.dequeuedSpecId).toBeUndefined();
    expect(queue.statusOf("run_c")).toBe("queued");
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("a missing configured GitHub credential hard-dequeues the head so later queue entries can proceed", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_missing_ref", specId: "spec_missing_ref", dependsOn: [], priority: "P0" });
    queue.seed({ runId: "run_next", specId: "spec_next", dependsOn: [], priority: "P1" });
    runner.throwFor("run_missing_ref", new MissingGithubCredentialRefError("credential/github/org/org_acme/default"));

    const blocked = await coordinator.coordinate(PROJECT);

    expect(blocked.dequeuedSpecId).toBe("spec_missing_ref");
    expect(blocked.holdReason).toBeUndefined();
    expect(blocked.retryAfterMs).toBeUndefined();
    expect(queue.statusOf("run_missing_ref")).toBe("dequeued");
    expect(queue.dequeueReasonOf("run_missing_ref")).toBe("blocked");
    const infraBlocked = events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(infraBlocked).toHaveLength(1);
    expect(infraBlocked[0]?.kind).toBe("missing_required_credential");
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);

    const next = await coordinator.coordinate(PROJECT);
    expect(next.mergedSpecId).toBe("spec_next");
    expect(queue.statusOf("run_next")).toBe("merged");
  });

  it("a missing required GitHub credential config hard-dequeues instead of retrying forever", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_no_config", specId: "spec_no_config", dependsOn: [], priority: "tbd" });
    runner.throwFor("run_no_config", new NoGithubCredentialConfiguredError());

    const result = await coordinator.coordinate(PROJECT);

    expect(result.dequeuedSpecId).toBe("spec_no_config");
    expect(result.holdReason).toBeUndefined();
    expect(result.retryAfterMs).toBeUndefined();
    expect(queue.statusOf("run_no_config")).toBe("dequeued");
    const infraBlocked = events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(infraBlocked).toHaveLength(1);
    expect(infraBlocked[0]?.kind).toBe("missing_required_credential");
  });

  it("a RETURNED recoverable block releases the claim with backoff — not a stranded dequeue", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_d", specId: "spec_d", dependsOn: [], priority: "tbd" });
    runner.returnFor("run_d", { kind: "blocked", message: "percolation owns the spec" });

    const result = await coordinator.coordinate(PROJECT);

    expect(result.holdReason).toBe("merge_retry");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.dequeuedSpecId).toBeUndefined();
    expect(queue.statusOf("run_d")).toBe("queued");
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });

  it("RECOVERS: a returned blocked hold then later merged drive lands the same queued entry", async () => {
    const { queue, runner, coordinator } = harness();
    queue.seed({ runId: "run_conflict_then_merge", specId: "spec_recover", dependsOn: [], priority: "tbd" });
    runner.returnFor("run_conflict_then_merge", { kind: "blocked", message: "retryable merge posture" });

    const held = await coordinator.coordinate(PROJECT);
    expect(held.holdReason).toBe("merge_retry");
    expect(queue.statusOf("run_conflict_then_merge")).toBe("queued");

    runner.returnFor("run_conflict_then_merge", { kind: "merged", mergeSha: "fixed" });
    const merged = await coordinator.coordinate(PROJECT);
    expect(merged.mergedSpecId).toBe("spec_recover");
    expect(queue.statusOf("run_conflict_then_merge")).toBe("merged");
  });

  it("BOUNDED: repeated returned blocks eventually emit infra_blocked and stay queued with backoff", async () => {
    const { queue, runner, events, coordinator } = harness();
    queue.seed({ runId: "run_loop", specId: "spec_loop", dependsOn: [], priority: "tbd" });
    runner.returnFor("run_loop", { kind: "blocked", message: "still blocked" });

    for (let i = 0; i < 4; i += 1) {
      const held = await coordinator.coordinate(PROJECT);
      expect(held.holdReason).toBe("merge_retry");
      expect(queue.statusOf("run_loop")).toBe("queued");
      expect(events.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(false);
    }
    const alerted = await coordinator.coordinate(PROJECT);

    expect(alerted.dequeuedSpecId).toBeUndefined();
    expect(alerted.holdReason).toBe("merge_retry");
    expect(alerted.retryAfterMs).toBe(60_000);
    expect(queue.statusOf("run_loop")).toBe("queued");
    const blocked = events.events.filter((e) => e.type === "merge.queue.infra_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.kind).toBe("ceiling");
    expect(events.events.some((e) => e.type === "merge.dequeued")).toBe(false);
  });
});
