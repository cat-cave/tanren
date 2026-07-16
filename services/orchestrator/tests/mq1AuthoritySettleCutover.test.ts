// cspell:ignore mqeval mqgrp mqwake
// mq-1 production cutover: member-attributed policy cannot become infra hold (v96).

import { describe, expect, it } from "vitest";
import type { MergeDriveOutcome, MergeQueueEntry } from "../src/engine/contracts/mergeCoordinator.js";
import type { WriterRecoveryReceipt } from "../src/engine/contracts/conflictResolution.js";
import {
  driveMessageForClassification,
  isClassifiedMemberPolicyMessage,
  MQ1_POLICY_MEMBER_REPAIR_MARKER,
  type MergeSignalClassificationV1,
} from "../src/engine/merge/authoritySignalClassification.js";
import { BatchMergeCoordinator } from "../src/engine/merge/batchCoordinator.js";
import { settleDriveOutcome, type BatchSettleDeps } from "../src/engine/merge/batchCoordinatorSettle.js";
import { escalateInfraHoldToWriter } from "../src/engine/merge/batchInfraEscalate.js";
import { holdOrHaltRecoverableDrive, RecoverableDriveHoldCeiling } from "../src/engine/merge/recoverableDriveHold.js";
import { MergeDispatcher, type DispatcherDeps } from "../src/engine/workflow/reviewMerge/mergeDispatcher.js";
import type { MergeForRunInput, MergeProbe } from "../src/engine/workflow/reviewMerge/index.js";
import {
  allowExactBatchAuthority,
  InMemoryBatchChecker,
  RecordingBatchGateReworkRouter,
  RecordingBatchMergeEventEmitter,
} from "./conformance/fakes/inMemoryBatchChecker.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import {
  InMemoryMergeQueueModel,
  RecordingMergeQueueEventEmitter,
  RecordingSpecEscalator,
  ScriptedMergeRunner,
} from "./conformance/fakes/inMemoryMergeQueue.js";
import { InMemoryRecoveryOwnedSettlementWriter } from "./conformance/fakes/inMemoryRecoveryOwnedSettlementWriter.js";
import {
  REPO,
  bundle,
  context,
  fakePool,
  mergeability,
  noopFinalizeWriter,
  reGate,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

const EVAL = `mqeval_${"c".repeat(64)}`;
const GROUP = `mqgrp_${"d".repeat(64)}`;
const PROJECT = "project_batch";

function policyClassification(): MergeSignalClassificationV1 {
  return {
    missionNodeId: "mq-1",
    evaluationId: EVAL,
    groupId: GROUP,
    signalVersion: "merge_signal.v1",
    memberIds: ["C"],
    findingIds: ["finding-p1"],
    classification: "deterministic_policy",
    reasonCode: "audit_policy",
    retryability: "non_retryable",
    wakeKey: null,
    disposition: "member_repair",
  };
}

function entry(specId: string): MergeQueueEntry {
  return {
    orgId: "org_mq1",
    projectId: "project_mq1",
    queueId: `q-${specId}`,
    runId: `run-${specId}`,
    specId,
    prUrl: `https://example.com/${specId}`,
    prNumber: 1,
    dependsOn: [],
    priority: "tbd",
    orderKey: 1,
  };
}

const writerReceipt: WriterRecoveryReceipt = {
  kind: "writer_rework",
  specId: "C",
  run: { kind: "enqueued", replanRunId: "run-repair-C", plannerTaskId: "task-repair-C" },
};

function settleDeps(infraEvents: unknown[], dequeued: string[]): BatchSettleDeps {
  return {
    queue: {
      async releaseClaim() {},
      async markMerged() {},
      async claim() {
        return true;
      },
      async loadSnapshot() {
        return {
          projectId: "project_mq1",
          entries: [],
          mergedSpecIds: new Set<string>(),
          mergingInFlight: false,
          depth: 1,
        };
      },
    } as BatchSettleDeps["queue"],
    events: {
      async emitAdvanced() {},
      async emitDequeued(input: { entry: MergeQueueEntry }) {
        dequeued.push(input.entry.specId);
      },
      async emitInfraBlocked(input: unknown) {
        infraEvents.push(input);
      },
    } as BatchSettleDeps["events"],
    escalator: {
      async escalate() {
        return { kind: "parked" as const, alreadyDequeued: false };
      },
    } as BatchSettleDeps["escalator"],
    gateRework: {
      async routeGateFailToRework() {
        return { kind: "owned" as const, receipt: writerReceipt };
      },
    } as BatchSettleDeps["gateRework"],
    recoverySettlement: {
      async settleOwnedRecoveryAndDequeue() {
        return { kind: "settled" as const, newlySettled: true };
      },
    },
    recoverableDriveHolds: new RecoverableDriveHoldCeiling(),
  };
}

function makeBatchHarness(maxBatchSize = 6) {
  const queue = new InMemoryMergeQueueModel();
  const runner = new ScriptedMergeRunner();
  const checker = new InMemoryBatchChecker();
  const events = new RecordingMergeQueueEventEmitter();
  const batchEvents = new RecordingBatchMergeEventEmitter();
  const escalator = new RecordingSpecEscalator();
  const gateRework = new RecordingBatchGateReworkRouter();
  const coordinator = new BatchMergeCoordinator({
    authorityEvaluator: allowExactBatchAuthority(),
    queue,
    runner,
    checker,
    events,
    batchEvents,
    escalator,
    recoverySettlement: new InMemoryRecoveryOwnedSettlementWriter(queue, events),
    gateRework,
    resolveMaxBatchSize: () => Promise.resolve(maxBatchSize),
    sleep: () => Promise.resolve(),
  });
  return { coordinator, queue, runner, checker, events, batchEvents, escalator, gateRework };
}

function seedMember(h: ReturnType<typeof makeBatchHarness>, specId: string): void {
  h.queue.seed({ runId: `run_${specId}`, specId, dependsOn: [], priority: "tbd" });
}

/** Full-payload EventStore capture for land-path classification proof. */
function recordingLandEvents() {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  return {
    events,
    append: async (input: { eventType: string; payload?: unknown }) => {
      events.push({ eventType: input.eventType, payload: input.payload ?? null });
    },
  };
}

function cleanProbe(): MergeProbe {
  return {
    readFreshness: async () => mergeability("clean"),
    readBaseBranch: async () => "main",
    retargetBase: async () => {},
  };
}

describe("mq-1 authority settle cutover (v96)", () => {
  it("embeds the member-repair marker so settle can refuse infra cosplay", () => {
    const message = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    expect(message).toContain(MQ1_POLICY_MEMBER_REPAIR_MARKER);
    expect(isClassifiedMemberPolicyMessage(message)).toBe(true);
    expect(isClassifiedMemberPolicyMessage("gate pending")).toBe(false);
  });

  it("routes classified policy blocked outcomes without merge.queue.infra_blocked", async () => {
    const infraEvents: unknown[] = [];
    const dequeued: string[] = [];
    const deps = settleDeps(infraEvents, dequeued);
    const message = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    const outcome: Extract<MergeDriveOutcome, { kind: "blocked" }> = { kind: "blocked", message };
    const settled = await settleDriveOutcome(deps, "project_mq1", entry("C"), outcome);
    // Atomic recovery settlement already retired the queue row (alreadyDequeued).
    expect(settled).toBe("dequeued");
    expect(infraEvents).toEqual([]);
    expect(dequeued).toEqual([]);
  });

  it("holdOrHaltRecoverableDrive never emits infra_blocked for member-policy markers", async () => {
    const infraEvents: unknown[] = [];
    const ceiling = new RecoverableDriveHoldCeiling();
    const message = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    const result = await holdOrHaltRecoverableDrive({
      ceiling,
      queue: { async releaseClaim() {} } as never,
      events: {
        async emitInfraBlocked(input: unknown) {
          infraEvents.push(input);
        },
      } as never,
      projectId: "project_mq1",
      entry: entry("C"),
      outcome: { kind: "blocked", message },
    });
    expect(result.kind).toBe("held");
    expect(infraEvents).toEqual([]);
  });

  it("batch infra escalate refuses classified policy messages for a six-member batch", async () => {
    const batchInfra: unknown[] = [];
    const message = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    const batch = ["A", "B", "C", "D", "E", "F"].map((specId) => entry(specId));
    const result = await escalateInfraHoldToWriter({
      queue: { async releaseClaim() {} } as never,
      events: { async emitDequeued() {} } as never,
      batchEvents: {
        async emitInfraBlocked(input: unknown) {
          batchInfra.push(input);
        },
      } as never,
      gateRework: {
        async routeGateFailToRework() {
          throw new Error("must not route policy as infra rework");
        },
      } as never,
      escalator: {
        async escalate() {
          throw new Error("must not escalate policy as infra");
        },
      } as never,
      ceiling: { async reset() {} } as never,
      projectId: "project_mq1",
      batch,
      message,
      holds: 3,
      queueDepth: 6,
    });
    expect(result.holdReason).toBe("all_blocked");
    expect(batchInfra).toEqual([]);
    expect(batch).toHaveLength(6);
  });

  it("failed policy outcome dequeues via writer repair without infra_blocked", async () => {
    const infraEvents: unknown[] = [];
    const dequeued: string[] = [];
    const deps = settleDeps(infraEvents, dequeued);
    const message = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    const settled = await settleDriveOutcome(deps, "project_mq1", entry("C"), {
      kind: "failed",
      message,
    });
    expect(settled).toBe("dequeued");
    expect(infraEvents).toEqual([]);
    // Atomic recovery settlement sets alreadyDequeued — no second dequeue event.
    expect(dequeued).toEqual([]);
  });

  it("mergeBatch continues after a dequeued policy member so eligible siblings still progress", async () => {
    // Coordinator-level MQ1-P6: production mergeBatch loop with continue (not break).
    // Member C fails with a classified policy message; A/B/D/E/F remain eligible and merge.
    const h = makeBatchHarness(6);
    for (const specId of ["A", "B", "C", "D", "E", "F"]) seedMember(h, specId);
    const policyMessage = driveMessageForClassification(policyClassification(), ["findings: P1 blocks"]);
    h.runner.script("run_C", { kind: "failed", message: policyMessage });

    const result = await h.coordinator.coordinate(PROJECT);

    // Culprit C: driven, writer-rework owned, dequeued — never whole-batch infra.
    expect(h.runner.drives.map((d) => d.runId)).toContain("run_C");
    expect(h.gateRework.routed.map((r) => r.specId)).toEqual(["C"]);
    expect(h.queue.statusOf("run_C")).toBe("dequeued");
    expect(h.events.events.some((e) => e.type === "merge.queue.infra_blocked")).toBe(false);
    expect(h.batchEvents.events.some((e) => e.type === "infra_blocked")).toBe(false);

    // Eligible siblings after C must still be driven and merged in the same cycle.
    // If mergeBatch's post-dequeue `continue` regresses to `break`, D/E/F stay queued.
    for (const specId of ["A", "B", "D", "E", "F"]) {
      expect(h.runner.drives.map((d) => d.runId)).toContain(`run_${specId}`);
      expect(h.queue.statusOf(`run_${specId}`)).toBe("merged");
    }
    expect(h.runner.drives.map((d) => d.runId)).toEqual(["run_A", "run_B", "run_C", "run_D", "run_E", "run_F"]);
    expect(result.holdReason).toBeUndefined();
    expect(result.dequeuedSpecId).toBe("C");
    expect(result.mergedSpecId).toBe("F");
  });

  it("landViaAuthority classifies findings-blocked MA-V2 as failed writer-repair, not success/infra", async () => {
    // Production seam: MergeDispatcher.directMerge → landViaAuthority → classifyLandAuthorityBlockForRun.
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingLandEvents();
    const landed: string[] = [];
    const findingsBlocked = {
      ...bundle(host, { landed }),
      findings: [
        {
          id: "finding-p1",
          severity: "P1" as const,
          title: "Product regression",
          body: "The built behavior violates the acceptance contract.",
        },
      ],
      auditPosture: {
        blockReviewAt: "P1" as const,
        p2p3Handling: "route-to-dag" as const,
        autonomousRemediation: true,
      },
    };
    const input = {
      pool: fakePool,
      secrets: {},
      githubHttp: {},
      runId: "run_1",
      resolveConflict: async () => ({ resolved: true }),
      reGateCi: reGate("passed"),
      mergeAuthority: findingsBlocked,
      runStateWriter: noopFinalizeWriter(),
    } as unknown as MergeForRunInput;
    const deps: DispatcherDeps = {
      input,
      context: { ...context(), orgId: "org_1" },
      eventStore: events as never,
      taskId: "task_1",
      integration: "native_queue",
      pr: { repo: REPO, pullNumber: 1 },
      probe: cleanProbe(),
    };
    const result = await new MergeDispatcher(deps).directMerge();

    // Writer-repair facing failed outcome (not recoverable infra hold, not merge success).
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain(MQ1_POLICY_MEMBER_REPAIR_MARKER);
    expect(result.message).toContain("finding-p1");
    expect(result.mergeSha).toBeUndefined();
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");

    const types = events.events.map((e) => e.eventType);
    // Classification append order: classified then policy_blocked (W0 algebra).
    const classifiedIdx = types.indexOf("merge.signal.classified");
    const policyIdx = types.indexOf("merge.member.policy_blocked");
    expect(classifiedIdx).toBeGreaterThanOrEqual(0);
    expect(policyIdx).toBeGreaterThan(classifiedIdx);
    const classifiedPayload = events.events[classifiedIdx]!.payload as MergeSignalClassificationV1;
    expect(classifiedPayload).toMatchObject({
      classification: "deterministic_policy",
      reasonCode: "audit_policy",
      disposition: "member_repair",
      memberIds: ["spec_1"],
      findingIds: ["finding-p1"],
      retryability: "non_retryable",
    });
    // No success land fact and no infrastructure classification cosplay.
    expect(types).not.toContain("merge.completed");
    expect(types).not.toContain("merge.queue.infra_blocked");
    expect(classifiedPayload.classification).not.toBe("transient_infrastructure");
  });
});
