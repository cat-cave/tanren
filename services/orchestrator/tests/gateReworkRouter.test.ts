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

const ORG = "org_test";
const PROJECT = "project_test";
const RUN = "run_dependent";
const SPEC = "spec_b";

/** A recording pool that captures only the spec-status park UPDATE (the router's only DB write here). */
function makeStatusPool(statusWrites: { specId: string; status: string }[]): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = String(text);
    if (sql.includes("UPDATE specs SET status")) {
      // The router passes the new status as $2 ($1 = specId).
      statusWrites.push({ specId: String(params?.[0]), status: String(params?.[1]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
}

function makeRouter(opts: {
  enqueuer: ReplanEnqueuer;
  /** The spec's prior gate-error SIGNATURES (oldest→newest) the convergence detector reads. */
  priorReworks: string[];
  events: FakeEventStore;
  statusWrites: { specId: string; status: string }[];
}): SpecStatusGateReworkRouter {
  return new SpecStatusGateReworkRouter({
    pool: makeStatusPool(opts.statusWrites),
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
    await router.routeGateFailToRework({ specId: SPEC, gateError });

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

    await router.routeGateFailToRework({ specId: SPEC, gateError: recurring });

    // No new rework run — escalated instead (the detector proved a dead-end fixed point).
    expect(enqueueCalls).toBe(0);
    expect(statusWrites).toContainEqual({ specId: SPEC, status: "needs_attention" });
    const routed = events.events.find((e) => e.eventType === "merge.regate.gate_rework_routed");
    expect(routed?.payload.disposition).toBe("escalated");
    const attention = events.events.find((e) => e.eventType === "dag.spec.needs_attention");
    expect(attention?.payload).toMatchObject({ reason: "persistent_failure" });
  });
});
