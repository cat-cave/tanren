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
import { settleDriveOutcome, type BatchSettleDeps } from "../src/engine/merge/batchCoordinatorSettle.js";
import { escalateInfraHoldToWriter } from "../src/engine/merge/batchInfraEscalate.js";
import { holdOrHaltRecoverableDrive, RecoverableDriveHoldCeiling } from "../src/engine/merge/recoverableDriveHold.js";

const EVAL = `mqeval_${"c".repeat(64)}`;
const GROUP = `mqgrp_${"d".repeat(64)}`;

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
});
