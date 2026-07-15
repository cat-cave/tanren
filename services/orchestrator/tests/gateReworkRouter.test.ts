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

/** A no-op pool: the audit-D-R3.2 sweep routes the router's spec-status writes through the
 * REQUIRED writer; the pool is only retained on the interface for the (unused-by-tests)
 * fallback shape. */
// eslint-disable-next-line @typescript-eslint/require-await
const noopPoolQuery = async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: [], rowCount: 0 });
function makeNoopPool(): pg.Pool {
  return {
    query: noopPoolQuery,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query: noopPoolQuery, release: () => {} }),
  } as unknown as pg.Pool;
}

function makeRouter(opts: {
  enqueuer: ReplanEnqueuer;
  /** The spec's prior gate-error SIGNATURES (oldest→newest) the convergence detector reads. */
  priorReworks: string[];
  events: FakeEventStore;
  statusWrites: { specId: string; status: string }[];
}): SpecStatusGateReworkRouter {
  // Audit D-R3.2: the writer is REQUIRED; the test's writer records both the bare
  // `setSpecStatus` flips (degenerate path) and the atomic `updateSpecWithEvent` parks
  // (the spec → `needs_attention` escalation), matching what the prior fake-pool UPDATE
  // recorder captured. The atomic park's `dag.spec.needs_attention` event ALSO forwards
  // into the FakeEventStore so the prior `events.events.find(...)` assertions still hold.
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
  return new SpecStatusGateReworkRouter({
    pool: makeNoopPool(),
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
    const enqueued: Array<{ specId: string; steeringNote: string; reopenStatus: string }> = [];
    const enqueuer: ReplanEnqueuer = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async enqueue(input) {
        enqueued.push({ specId: input.specId, steeringNote: input.steeringNote, reopenStatus: input.reopenStatus });
        return { replanRunId: "run_rework_1", plannerTaskId: "task_1" };
      },
    };
    const events = new FakeEventStore();
    const statusWrites: { specId: string; status: string }[] = [];
    const router = makeRouter({ enqueuer, priorReworks: [], events, statusWrites });

    const gateError = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    const result = await router.routeGateFailToRework({ specId: SPEC, gateError });
    expect(result).toMatchObject({
      kind: "owned",
      receipt: { kind: "writer_rework", run: { kind: "enqueued" } },
    });

    // A fresh rework run was enqueued, re-opening the spec to `open` and carrying the ACTUAL
    // gate error in the steering (no_silent_fallback — never rework blind).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.reopenStatus).toBe("open");
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

  it("FIXED POINT returns parking_required (no further rework) — settlement parks, router does not self-park", async () => {
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
    // transient repeat) → a proven fixed point. One-authority: parking_required, not self-park.
    const router = makeRouter({
      enqueuer,
      priorReworks: [gateErrorSignature(recurring), gateErrorSignature(recurring)],
      events,
      statusWrites,
    });

    const result = await router.routeGateFailToRework({ specId: SPEC, gateError: recurring });

    // No new rework run — fixed point returns parking_required for settlement.
    expect(enqueueCalls).toBe(0);
    expect(result.kind).toBe("parking_required");
    expect(result.kind === "parking_required" && result.message).toMatch(/fixed point/u);
    expect(statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
    expect(events.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
    expect(events.events.some((e) => e.eventType === "merge.regate.gate_rework_routed")).toBe(false);
  });
});
