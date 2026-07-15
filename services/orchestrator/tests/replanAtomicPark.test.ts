// Atomic both-or-neither for SpecStatusReplanRouter park authority:
// applyUpdateSpecWithEvent does not return flipped:true when the event write fails
// after a successful status UPDATE (callers must not treat the park as durable).

import { describe, expect, it } from "vitest";
import { applyUpdateSpecWithEvent } from "../src/engine/worker/runStateAtomicSql.js";

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
        // Simulate the event-store write failing after the row moved (txn would roll back).
        throw new Error("event write failed after status flip");
      },
    };

    await expect(
      applyUpdateSpecWithEvent(client as never, {
        spec: {
          specId: "spec_a",
          orgId: "org_a",
          status: "needs_attention",
          notFromStatuses: ["merged", "cancelled", "needs_attention"],
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
        notFromStatuses: ["merged", "cancelled", "needs_attention"],
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
