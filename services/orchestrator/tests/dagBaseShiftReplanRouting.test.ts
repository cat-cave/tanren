// BLOCKING-2 PROOF (tanren-owns-the-engine.md §3 never-discard): a base-shift / percolation
// REPLAN must genuinely route the spec BACK TO THE PLANNER — it must do the SAME spec-STATUS
// transition the merge-path conflict replan does (the shared `SpecStatusReplanRouter`), not
// merely append an event with no control-flow effect. `recordReplanContext` (the shared write
// both the base-shift `PgBaseShiftPersistence.recordReplan` and the percolation settler use)
// is asserted here to (1) TRANSITION the spec status to a planner re-entry state (`in_flight`),
// THEN (2) append the durable `merge.conflict.replan_routed` event the next planner pass reads.
//
// Driven through TEST FIXTURES (they live here, never src/): a minimal fake pool answering only
// the system-scope org lookup, and a recording RunStateWriter (the plane-split control-plane
// path) capturing the status write + the event append — so no real DB is needed.

import { describe, expect, it } from "vitest";
import type { RunStateWriter, SetSpecStatusInput } from "../src/engine/contracts/runStateWriter.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import { recordReplanContext } from "../src/engine/dag/percolationWrites.js";

const ORG = "org_replan";
const PROJECT = "project_replan";

/** A fake pool answering only `resolveProjectOrg`'s system-scope `SELECT org_id FROM projects`. */
class OrgOnlyPool {
  async connect(): Promise<OrgOnlyClient> {
    return new OrgOnlyClient();
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new OrgOnlyClient().query(sql, params);
  }
}

class OrgOnlyClient {
  release(): void {
    /* no-op */
  }
  async query(sql: string): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK")
    ) {
      return { rows: [] };
    }
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    throw new Error(`unexpected pool query in replan-routing test: ${text}`);
  }
}

/** Records EXACTLY the status transition + the event append the shared router drives. */
class RecordingReplanWriter implements Pick<RunStateWriter, "setSpecStatus" | "append"> {
  readonly statusWrites: SetSpecStatusInput[] = [];
  readonly events: AppendEventInput[] = [];
  // Order log: proves the STATUS transition happens (the control-flow effect), not just an event.
  readonly order: string[] = [];
  async setSpecStatus(input: SetSpecStatusInput): Promise<void> {
    this.statusWrites.push(input);
    this.order.push("setSpecStatus");
  }
  async append(input: AppendEventInput): Promise<void> {
    this.events.push(input);
    this.order.push("append");
  }
}

describe("base-shift / percolation replan routing (BLOCKING-2 — genuinely re-enters the planner)", () => {
  it("recordReplanContext TRANSITIONS the spec status to in_flight AND appends the replan event (not event-only)", async () => {
    const writer = new RecordingReplanWriter();
    await recordReplanContext(
      new OrgOnlyPool() as never,
      {
        projectId: PROJECT,
        specId: "spec_b",
        runId: "run_b",
        ancestorSpecId: "spec_a",
        ancestorSha: "sha-new",
        reason: "the rebased branch failed its re-gate on the shifted base",
      },
      writer as RunStateWriter,
    );

    // (1) THE FIX: the spec STATUS was transitioned to a planner re-entry state — this is what
    // re-enters planner control flow (the prior impl never did this).
    expect(writer.statusWrites).toHaveLength(1);
    expect(writer.statusWrites[0]).toMatchObject({ specId: "spec_b", orgId: ORG, status: "in_flight" });
    // (2) the durable replan-context event is appended (the carrier the next planner reads).
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]?.eventType).toBe("merge.conflict.replan_routed");
    expect(writer.events[0]?.specId).toBe("spec_b");
    // The status transition happens BEFORE the event (the router's order), so the event is
    // never appended without the control-flow effect having landed first.
    expect(writer.order).toEqual(["setSpecStatus", "append"]);
  });
});
