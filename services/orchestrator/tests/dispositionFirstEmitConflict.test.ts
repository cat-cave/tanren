// F3 hostile: emitConflict disposition-first aux history.
// Old bug: always append merge.conflict before branching on recovery.

import { describe, expect, it } from "vitest";
import type { ConflictRecoveryDisposition } from "../src/engine/contracts/conflictResolution.js";
import { shouldEmitOwnedConflictAux } from "../src/engine/merge/recoveryOwnership.js";
import type { ConflictResolverResult } from "../src/engine/workflow/reviewMerge/index.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import {
  buildDispatcher,
  bundle,
  countingResolver,
  recordingEventStore,
  REPO,
  scriptedProbe,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

async function dispatchWithRecovery(recovery: ConflictRecoveryDisposition) {
  const host = new InMemoryCodeHost();
  host.seed(REPO, "main", "sha-main");
  await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
  const events = recordingEventStore();
  const landed: string[] = [];
  const result = await buildDispatcher({
    probe: scriptedProbe("dirty"),
    events,
    bundle: bundle(host, { landed }),
    resolveConflict: async (): Promise<ConflictResolverResult> => ({ resolved: false, recovery }),
  }).directMerge();
  return { result, events, landed };
}

describe("F3 emitConflict disposition-first (no misleading aux)", () => {
  it("owned → merge.conflict aux + conflict outcome", async () => {
    const { result, events } = await dispatchWithRecovery({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_1",
        run: { kind: "enqueued", replanRunId: "r", plannerTaskId: "t" },
      },
    });
    expect(result.outcome).toBe("conflict");
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(1);
  });

  it("terminal_noop → zero merge.conflict aux", async () => {
    const { result, events } = await dispatchWithRecovery({
      kind: "terminal_noop",
      status: "merged",
      message: "already merged",
    });
    expect(result.outcome).toBe("needs_attention");
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(0);
    expect(result.conflictRecovery?.kind).toBe("terminal_noop");
  });

  it("parking_failed → zero merge.conflict aux", async () => {
    const { result, events } = await dispatchWithRecovery({
      kind: "parking_failed",
      message: "park failed",
      observedStatus: "in_flight",
    });
    expect(result.outcome).toBe("needs_attention");
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(0);
    expect(result.conflictRecovery?.kind).toBe("parking_failed");
  });

  it("HOSTILE: parking_required must not race ahead of sole park authority (no merge.conflict)", async () => {
    const { result, events } = await dispatchWithRecovery({
      kind: "parking_required",
      message: "settlement must escalate once",
    });
    expect(result.outcome).toBe("needs_attention");
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(0);
    expect(shouldEmitOwnedConflictAux("parking_required")).toBe(false);
    expect(result.conflictRecovery?.kind).toBe("parking_required");
  });

  it("parked → no merge.conflict (park lineage is the truth)", async () => {
    const { result, events } = await dispatchWithRecovery({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_1", source: "planner_replan" },
      message: "parked",
    });
    expect(result.outcome).toBe("needs_attention");
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(0);
  });

  it("countingResolver(false) owned still emits exactly one merge.conflict (no regression)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingEventStore();
    const landed: string[] = [];
    const counting = countingResolver(false);
    await buildDispatcher({
      probe: scriptedProbe("dirty"),
      events,
      bundle: bundle(host, { landed }),
      resolveConflict: counting.hook,
    }).directMerge();
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(1);
  });
});
