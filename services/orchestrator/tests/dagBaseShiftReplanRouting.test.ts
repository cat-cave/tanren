import { describe, expect, it } from "vitest";
import type { RecoveryPreparationOutcome } from "../src/engine/contracts/recoveryPreparation.js";
import {
  conflictSignatureOf,
  type PriorReplanReader,
  type ReplanEnqueuer,
  SpecStatusReplanRouter,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const ORG = "org_replan";
const PROJECT = "project_replan";
const OLD_RUN = "run_old";
const DEFAULT_OUTCOME: RecoveryPreparationOutcome = {
  kind: "owned",
  newlyPrepared: true,
  receipt: {
    kind: "planner_replan",
    specId: "spec_b",
    run: { kind: "enqueued", replanRunId: "run_new", plannerTaskId: "task_new" },
  },
};

class RecordingEnqueuer implements ReplanEnqueuer {
  readonly calls: Parameters<ReplanEnqueuer["enqueue"]>[0][] = [];
  constructor(private readonly outcome: RecoveryPreparationOutcome = DEFAULT_OUTCOME) {}
  async enqueue(input: Parameters<ReplanEnqueuer["enqueue"]>[0]): Promise<RecoveryPreparationOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

function readerReturning(signatures: string[]): PriorReplanReader {
  return { signatures: async () => signatures };
}

function router(enqueuer: ReplanEnqueuer, priorReplans: PriorReplanReader = readerReturning([])) {
  return new SpecStatusReplanRouter({
    orgId: ORG,
    runId: OLD_RUN,
    projectId: PROJECT,
    enqueuer,
    priorReplans,
  });
}

describe("base-shift recovery preparation routing", () => {
  it("delegates all successor writes and canonical events to one atomic request", async () => {
    const enqueuer = new RecordingEnqueuer();
    const context = "re-plan on top of spec_a at sha-new";
    const result = await router(enqueuer).routeBackToPlanner({
      specId: "spec_b",
      otherSpecId: "spec_a",
      newContext: context,
    });

    expect(result).toMatchObject({ kind: "owned", receipt: { kind: "planner_replan" } });
    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.calls[0]).toEqual({
      specId: "spec_b",
      orgId: ORG,
      projectId: PROJECT,
      steeringNote: context,
      reopenStatus: "open",
      oldRunId: OLD_RUN,
      route: {
        kind: "planner_replan",
        newContext: context,
        otherSpecId: "spec_a",
        conflictSignature: conflictSignatureOf(context, "spec_a"),
      },
    });
  });

  it("stops at a fixed point before preparing another successor", async () => {
    const context = "same conflict";
    const signature = conflictSignatureOf(context, "spec_a");
    const enqueuer = new RecordingEnqueuer();
    const result = await router(enqueuer, readerReturning([signature, signature])).routeBackToPlanner({
      specId: "spec_b",
      otherSpecId: "spec_a",
      newContext: context,
    });
    expect(result.kind).toBe("parking_required");
    expect(enqueuer.calls).toHaveLength(0);
  });

  it("keeps preparing while conflict signatures change", async () => {
    const enqueuer = new RecordingEnqueuer();
    const result = await router(
      enqueuer,
      readerReturning(["c1", "c2", "c3"].map((value) => conflictSignatureOf(value, "spec_a"))),
    ).routeBackToPlanner({ specId: "spec_b", otherSpecId: "spec_a", newContext: "new conflict" });
    expect(result.kind).toBe("owned");
    expect(enqueuer.calls).toHaveLength(1);
  });

  it.each([
    { kind: "conflict", message: "another owner won" } as const,
    { kind: "failure", reason: "transport_failed", message: "readback unavailable" } as const,
  ])("retains on $kind instead of converting uncertainty into a park", async (outcome) => {
    const result = await router(new RecordingEnqueuer(outcome)).routeBackToPlanner({
      specId: "spec_b",
      newContext: "new context",
    });
    expect(result).toMatchObject({ kind: "parking_failed", message: expect.stringContaining(outcome.message) });
  });

  it("propagates an atomic terminal race", async () => {
    const outcome = {
      kind: "terminal_noop",
      status: "merged",
      message: "terminal during preparation",
    } as const;
    await expect(
      router(new RecordingEnqueuer(outcome)).routeBackToPlanner({ specId: "spec_b", newContext: "context" }),
    ).resolves.toEqual(outcome);
  });
});
