// Unit tests for the SpecStatusGateReworkRouter (v35 — the re-gate-gate-fail-mis-classified-
// as-irreconcilable-conflict fix). The router re-authors a spec whose PRE-MERGE / base-shift
// re-gate failed a GATE TIER on a cleanly-rebased-or-resolved tree, on the never-discard
// re-plan-with-steering mechanism (carrying the re-gate error), and escalates ONLY at a
// convergence FIXED POINT (the SAME gate error recurs) — never a count. These tests inject
// the enqueuer + prior-rework signatures + a recording event store + a recording pool (the
// spec-status park) so the routing + the fixed-point escalation are verified WITHOUT a DB.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { SpecStatusGateReworkRouter } from "../src/engine/workflow/reviewMerge/conflictResolver/gateReworkRouter.js";
import {
  gateErrorSignature,
  type ReplanEnqueuer,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const ORG = "org_test";
const PROJECT = "project_test";
const RUN = "run_dependent";
const SPEC = "spec_b";

function makeRouter(opts: {
  enqueuer: ReplanEnqueuer;
  /** The spec's prior gate-error SIGNATURES (oldest→newest) the convergence detector reads. */
  priorReworks: string[];
  events: FakeEventStore;
  statusWrites: { specId: string; status: string }[];
  /** Current status for notFromStatuses + durable park readback (default open). */
  specStatus?: string;
}): SpecStatusGateReworkRouter {
  // Sole atomic park authority: recording RunStateWriter (no pool UPDATE / appendEvent split).
  const writer = new InMemoryRunStateWriter({
    forwardAppend: (event) => {
      opts.events.append(event);
    },
    forwardSetSpecStatus: (input) => {
      opts.statusWrites.push({ specId: input.specId, status: input.status });
    },
    forwardUpdateSpecWithEvent: (input) => {
      opts.statusWrites.push({ specId: input.spec.specId, status: input.spec.status });
    },
  });
  writer.updateSpecCurrentStatus = opts.specStatus ?? "open";
  const status = opts.specStatus ?? "open";
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = String(text);
    if (sql.includes("SELECT status FROM specs")) {
      return { rows: [{ status }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
  return new SpecStatusGateReworkRouter({
    pool,
    runStateWriter: writer,
    orgId: ORG,
    eventStore: opts.events,
    runId: RUN,
    projectId: PROJECT,
    prNumber: 0,
    enqueuer: opts.enqueuer,
    priorReworks: () => Promise.resolve(opts.priorReworks),
  });
}

describe("SpecStatusGateReworkRouter — re-gate gate-fail → writer rework, fixed-point escalate", () => {
  it("re-authors the spec (carrying the gate error as steering) + records reworked while making progress", async () => {
    const enqueued: Array<{ specId: string; steeringNote: string }> = [];
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue(input) {
        enqueued.push({ specId: input.specId, steeringNote: input.steeringNote });
        return { replanRunId: "run_rework_1", plannerTaskId: "task_1" };
      },
    };
    const events = new FakeEventStore();
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({ enqueuer, priorReworks: [], events, statusWrites });

    const gateError = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    const recovery = await router.routeGateFailToRework({ specId: SPEC, gateError });

    expect(recovery).toEqual({
      kind: "owned",
      receipt: {
        kind: "writer_rework",
        specId: SPEC,
        run: { kind: "enqueued", replanRunId: "run_rework_1", plannerTaskId: "task_1" },
      },
    });

    // A fresh rework run was enqueued, re-opening the spec to `open` and carrying the ACTUAL
    // gate error in the steering (no_silent_fallback — never rework blind).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.steeringNote).toContain(gateError);
    // The observable routing event is recorded as `reworked` + a replan_queued lineage.
    const routed = events.events.find((e) => e.eventType === "merge.regate.gate_rework_routed");
    expect(routed?.payload).toMatchObject({ disposition: "reworked", gateError, specId: SPEC });
    expect(events.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(true);
    // It did NOT park the spec at needs_attention, and emitted NO irreconcilable/needs_attention.
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  it("KEEPS re-working unbounded while the gate error CHANGES (progress, no count)", async () => {
    let enqueueCalls = 0;
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue() {
        enqueueCalls += 1;
        return { replanRunId: `run_rework_${enqueueCalls}`, plannerTaskId: `task_${enqueueCalls}` };
      },
    };
    const events = new FakeEventStore();
    const statusWrites: { specId: string; status: string }[] = [];
    // MANY prior reworks, but each a DIFFERENT error — the trajectory is progressing.
    const priorReworks = Array.from({ length: 9 }, (_, i) => gateErrorSignature(`error variant ${i}`));
    const router = makeRouter({ enqueuer, priorReworks, events, statusWrites });

    await router.routeGateFailToRework({ specId: SPEC, gateError: "a BRAND NEW gate error never seen before" });

    // Still re-works (progress) — never escalates on a count.
    expect(enqueueCalls).toBe(1);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
    const routed = events.events.find((e) => e.eventType === "merge.regate.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("reworked");
  });

  it("ESCALATES to needs_attention (no further rework) at a FIXED POINT — the SAME gate error recurs", async () => {
    let enqueueCalls = 0;
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue() {
        enqueueCalls += 1;
        return { replanRunId: "run_rework_n", plannerTaskId: "task_n" };
      },
    };
    const events = new FakeEventStore();
    const statusWrites: { specId: string; status: string }[] = [];
    const recurring = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    // The identical error signature RECURS across multiple prior reworks (a cycle, not a single
    // transient repeat) → a proven fixed point ⇒ escalate.
    const router = makeRouter({
      enqueuer,
      priorReworks: [gateErrorSignature(recurring), gateErrorSignature(recurring)],
      events,
      statusWrites,
    });

    const recovery = await router.routeGateFailToRework({ specId: SPEC, gateError: recurring });

    expect(recovery).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: SPEC, source: "writer_rework" },
    });

    // No new rework run — escalated instead (the detector proved a dead-end fixed point).
    expect(enqueueCalls).toBe(0);
    expect(statusWrites).toContainEqual({ specId: SPEC, status: "needs_attention" });
    const routed = events.events.find((e) => e.eventType === "merge.regate.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("escalated");
    const attention = events.events.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(attention?.payload).toMatchObject({ reason: "persistent_failure" });
  });

  it("CONCURRENT CANCEL: terminal_noop with zero status change and zero park event", async () => {
    const enqueuer: ReplanEnqueuer = {
      enqueue() {
        return Promise.reject(new Error("planner unavailable"));
      },
    };
    const events = new FakeEventStore();
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({
      enqueuer,
      priorReworks: [],
      events,
      statusWrites,
      specStatus: "cancelled",
    });

    const recovery = await router.routeGateFailToRework({ specId: SPEC, gateError: "gate failed" });
    expect(recovery).toMatchObject({ kind: "terminal_noop", status: "cancelled" });
    expect(statusWrites).toEqual([]);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });
});
