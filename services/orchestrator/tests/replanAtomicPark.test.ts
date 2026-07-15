// Atomic both-or-neither for SpecStatusReplanRouter park authority + settlement
// race controls: updateSpecWithEvent outcomes must never fabricate parked receipts;
// concurrent terminal_noop settles without parking:complete.

import { describe, expect, it } from "vitest";
import { mapConflictDriveOutcome } from "../src/engine/merge/coordinatorBuild.js";
import { settleWriterOwnedOrPark } from "../src/engine/merge/batchCoordinatorSettle.js";
import { parkOutcomeToRouteResult, parkSpecNeedsAttention } from "../src/engine/merge/parkNeedsAttention.js";
import { applyUpdateSpecWithEvent } from "../src/engine/worker/runStateAtomicSql.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type pg from "pg";

const parkEvent = {
  runId: "run_a",
  specId: "spec_a",
  projectId: "proj_a",
  orgId: "org_a",
  eventType: "dag.spec.needs_attention" as const,
  payload: {
    source: "strand",
    specId: "spec_a",
    reason: "persistent_failure" as const,
    terminalRuns: [{ runId: "run_a", status: "halted" }],
    attempts: 0,
    message: "park",
  },
};

const CANONICAL_GUARD = ["merged", "cancelled", "halted", "needs_attention"] as const;

function makeParkWriter(flipped: boolean): RunStateWriter {
  return {
    updateSpecWithEvent: async () => ({ flipped, alreadyTerminal: false }),
  } as unknown as RunStateWriter;
}

function makeParkStatusPool(status: string | undefined): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string): Promise<{ rows: unknown[] }> => {
    if (String(text).includes("SELECT status FROM specs")) {
      return status === undefined ? { rows: [] } : { rows: [{ status }] };
    }
    return { rows: [] };
  };
  return {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
}

describe("applyUpdateSpecWithEvent — both-or-neither park", () => {
  it("throws (does not return flipped) when the post-UPDATE event write fails", async () => {
    const queries: string[] = [];
    let status = "in_flight";
    const client = {
      async query(sql: string, params?: unknown[]) {
        const text = String(sql);
        queries.push(text.replaceAll(/\s+/gu, " ").trim());
        if (text.includes("UPDATE specs SET status") && text.includes("RETURNING")) {
          const blocked = Array.isArray(params?.[2]) && (params[2] as string[]).includes(status);
          if (blocked) return { rows: [], rowCount: 0 };
          status = String(params?.[1] ?? status);
          return { rows: [{ spec_id: params?.[0] }], rowCount: 1 };
        }
        throw new Error("event write failed after status flip");
      },
    };

    await expect(
      applyUpdateSpecWithEvent(client as never, {
        spec: {
          specId: "spec_a",
          orgId: "org_a",
          status: "needs_attention",
          notFromStatuses: [...CANONICAL_GUARD],
        },
        event: parkEvent,
      }),
    ).rejects.toThrow(/event write failed after status flip/u);

    expect(queries.some((q) => q.includes("UPDATE specs SET status"))).toBe(true);
  });

  it("returns flipped:false with no event work when notFromStatuses blocks the row", async () => {
    let eventWriteAttempted = false;
    const client = {
      async query(sql: string, _params?: unknown[]) {
        if (String(sql).includes("UPDATE specs SET status")) {
          return { rows: [], rowCount: 0 };
        }
        eventWriteAttempted = true;
        return { rows: [], rowCount: 0 };
      },
    };
    const outcome = await applyUpdateSpecWithEvent(client as never, {
      spec: {
        specId: "spec_a",
        orgId: "org_a",
        status: "needs_attention",
        notFromStatuses: [...CANONICAL_GUARD],
      },
      event: {
        ...parkEvent,
        payload: {
          ...parkEvent.payload,
          reason: "human_decision",
          attempts: 1,
        },
      },
    });
    expect(outcome).toEqual({ flipped: false, alreadyTerminal: false });
    expect(eventWriteAttempted).toBe(false);
  });
});

describe("parkSpecNeedsAttention + settlement race", () => {
  it("false flip + needs_attention readback → parked (not fabricated without proof)", async () => {
    const outcome = await parkSpecNeedsAttention({
      writer: makeParkWriter(false),
      pool: makeParkStatusPool("needs_attention"),
      orgId: "org_a",
      specId: "spec_a",
      event: parkEvent,
    });
    expect(outcome).toEqual({ kind: "parked", newlyFlipped: false });
    const route = parkOutcomeToRouteResult(outcome, {
      specId: "spec_a",
      source: "planner_replan",
      message: "escalate",
    });
    expect(route.kind).toBe("parked");
  });

  it("false flip + cancelled readback → terminal_noop (never parked receipt)", async () => {
    const outcome = await parkSpecNeedsAttention({
      writer: makeParkWriter(false),
      pool: makeParkStatusPool("cancelled"),
      orgId: "org_a",
      specId: "spec_a",
      event: parkEvent,
    });
    expect(outcome).toEqual({ kind: "terminal_noop", status: "cancelled" });
    const route = parkOutcomeToRouteResult(outcome, {
      specId: "spec_a",
      source: "writer_rework",
      message: "escalate",
    });
    expect(route.kind).toBe("terminal_noop");
  });

  it("mapConflictDriveOutcome: exhaustive parking arms", () => {
    const parked = mapConflictDriveOutcome({
      message: "conflict",
      conflictRecovery: {
        kind: "parked",
        receipt: { kind: "needs_attention", specId: "s", source: "planner_replan" },
        message: "parked loud",
      },
    });
    expect(parked).toMatchObject({ kind: "needs_attention", parking: "complete" });

    const noop = mapConflictDriveOutcome({
      message: "conflict",
      conflictRecovery: {
        kind: "terminal_noop",
        status: "cancelled",
        message: "concurrent cancel",
      },
    });
    expect(noop).toMatchObject({
      kind: "needs_attention",
      parking: "terminal_noop",
      terminalStatus: "cancelled",
    });

    const required = mapConflictDriveOutcome({
      message: "conflict",
      conflictRecovery: { kind: "parking_required", message: "fixed point" },
    });
    expect(required).toMatchObject({ kind: "needs_attention", parking: "required" });

    const failed = mapConflictDriveOutcome({
      message: "conflict",
      conflictRecovery: { kind: "parking_failed", message: "live row", observedStatus: "in_flight" },
    });
    expect(failed).toMatchObject({ kind: "needs_attention", parking: "parking_failed" });
  });

  it("settleWriterOwnedOrPark: terminal_noop → superseded without SpecEscalator", async () => {
    let escalations = 0;
    const settled = await settleWriterOwnedOrPark(
      {
        recoveryEvidence: undefined,
        escalator: {
          escalate: async () => {
            escalations += 1;
            return { kind: "parked", newlyFlipped: true };
          },
        },
      },
      "proj",
      {
        queueId: "q1",
        runId: "run1",
        specId: "spec1",
        prUrl: "u",
        prNumber: 1,
        dependsOn: [],
        priority: "tbd",
        orderKey: 0,
      },
      { kind: "terminal_noop", status: "cancelled", message: "concurrent cancel" },
      "owned msg",
      "ctx",
    );
    expect(settled).toEqual({ action: "dequeue", reason: "superseded", message: "concurrent cancel" });
    expect(escalations).toBe(0);
  });

  it("settleWriterOwnedOrPark: parked → needs_attention without re-escalating", async () => {
    let escalations = 0;
    const settled = await settleWriterOwnedOrPark(
      {
        recoveryEvidence: undefined,
        escalator: {
          escalate: async () => {
            escalations += 1;
            return { kind: "parked", newlyFlipped: true };
          },
        },
      },
      "proj",
      {
        queueId: "q1",
        runId: "run1",
        specId: "spec1",
        prUrl: "u",
        prNumber: 1,
        dependsOn: [],
        priority: "tbd",
        orderKey: 0,
      },
      {
        kind: "parked",
        message: "parked",
        receipt: { kind: "needs_attention", specId: "spec1", source: "writer_rework" },
      },
      "owned msg",
      "ctx",
    );
    expect(settled).toEqual({ action: "dequeue", reason: "needs_attention", message: "parked" });
    expect(escalations).toBe(0);
  });

  it("settleWriterOwnedOrPark: parking_failed → retain (never dequeue as needs_attention)", async () => {
    let escalations = 0;
    const settled = await settleWriterOwnedOrPark(
      {
        recoveryEvidence: undefined,
        escalator: {
          escalate: async () => {
            escalations += 1;
            return { kind: "parked", newlyFlipped: true };
          },
        },
      },
      "proj",
      {
        queueId: "q1",
        runId: "run1",
        specId: "spec1",
        prUrl: "u",
        prNumber: 1,
        dependsOn: [],
        priority: "tbd",
        orderKey: 0,
      },
      { kind: "parking_failed", message: "live in_flight", observedStatus: "in_flight" },
      "owned msg",
      "ctx",
    );
    expect(settled).toEqual({ action: "retain", message: "live in_flight" });
    expect(escalations).toBe(0);
  });

  it("settleWriterOwnedOrPark: parking_required escalates exactly once and branches", async () => {
    let escalations = 0;
    const settled = await settleWriterOwnedOrPark(
      {
        recoveryEvidence: undefined,
        escalator: {
          escalate: async () => {
            escalations += 1;
            return { kind: "parked", newlyFlipped: true };
          },
        },
      },
      "proj",
      {
        queueId: "q1",
        runId: "run1",
        specId: "spec1",
        prUrl: "u",
        prNumber: 1,
        dependsOn: [],
        priority: "tbd",
        orderKey: 0,
      },
      { kind: "parking_required", message: "fixed point" },
      "owned msg",
      "ctx",
    );
    expect(settled).toEqual({ action: "dequeue", reason: "needs_attention", message: "fixed point" });
    expect(escalations).toBe(1);
  });
});
