// CONVERGENCE PROOF (v35 — the replan-routed-but-never-executed stall): a base-shift /
// percolation REPLAN must not merely flip the spec's status + append an event. The
// confirmed live stall was a spec whose irreconcilable base-shift conflict routed it to a
// re-plan (`merge.conflict.replan_routed`) that NEVER RAN — the spec sat `in_flight` with
// NO live run, never re-driven, because the walker reads `in_flight` as "occupying a slot"
// and the run-create claim only fires on `open`. So `replan_routed` recorded the routing
// but no run was ever enqueued (NO `recovery.replan_queued`, no `replanRunId`).
//
// These assert the `SpecStatusReplanRouter` (the single chokepoint both replan routes —
// the base-shift coordinator's `recordReplanContext` AND the drive-path resolver — reach):
//   (1) it re-opens the spec to the RE-DRIVABLE `open` status (NOT `in_flight`), ENQUEUES a
//       fresh re-plan run, and emits the OBSERVABLE `recovery.replan_queued` carrying the
//       `replanRunId` — so the routed replan ACTUALLY RUNS (fails without the fix);
//   (2) the re-plan carries the replan context as steering (intent stays alive);
//   (3) BOUNDED: a spec already routed `MAX_BASE_SHIFT_REPLANS` times that STILL cannot be
//       re-planned ESCALATES as a genuine `needs_attention` human decision — never another
//       silent re-plan, never an infinite hot-loop.
//
// Driven through TEST FIXTURES (they live here, never src/): a recording enqueuer + a
// scripted prior-replan counter + a recording event store — no real DB/runner needed.

import { describe, expect, it } from "vitest";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import {
  MAX_BASE_SHIFT_REPLANS,
  type PriorReplanCounter,
  type ReplanEnqueuer,
  SpecStatusReplanRouter,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const ORG = "org_replan";
const PROJECT = "project_replan";

/** Records the spec-status UPDATEs the router drives through its in-process pool path. */
class RecordingPool {
  readonly statusWrites: Array<{ specId: string; status: string }> = [];
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (text.startsWith("UPDATE specs SET status")) {
      this.statusWrites.push({ specId: String(params?.[0]), status: String(params?.[1]) });
      return { rows: [] };
    }
    throw new Error(`unexpected pool query in replan-routing test: ${text}`);
  }
}

/** Records the events the router appends (the timeline carrier). */
class RecordingEventStore implements Pick<EventStore, "append"> {
  readonly events: AppendEventInput[] = [];
  async append(input: AppendEventInput): Promise<void> {
    this.events.push(input);
  }
}

/** Records the re-plan run enqueue (the never-discard re-author) — returns a fixed run id. */
class RecordingEnqueuer implements ReplanEnqueuer {
  readonly calls: Array<{
    specId: string;
    orgId: string;
    projectId: string;
    steeringNote: string;
    reopenStatus: string;
  }> = [];
  constructor(private readonly replanRunId = "run_replan_new") {}
  async enqueue(input: {
    specId: string;
    orgId: string;
    projectId: string;
    steeringNote: string;
    reopenStatus: string;
  }): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls.push(input);
    return { replanRunId: this.replanRunId, plannerTaskId: `task_${this.replanRunId}` };
  }
}

/** A scripted prior-replan counter (the bounded-replan budget). */
function counterReturning(n: number): PriorReplanCounter {
  return { count: async () => n };
}

/** Find the (asserted-present) event of a type and return its payload as a record. */
function payloadOf(events: AppendEventInput[], eventType: string): Record<string, unknown> {
  const event = events.find((e) => e.eventType === eventType);
  expect(event, `expected a ${eventType} event`).toBeDefined();
  return (event as AppendEventInput).payload as Record<string, unknown>;
}

function buildRouter(deps: {
  pool: RecordingPool;
  eventStore: RecordingEventStore;
  enqueuer?: ReplanEnqueuer;
  priorReplans?: PriorReplanCounter;
}): SpecStatusReplanRouter {
  return new SpecStatusReplanRouter({
    pool: deps.pool,
    orgId: ORG,
    eventStore: deps.eventStore,
    runId: "run_b",
    projectId: PROJECT,
    ...(deps.enqueuer !== undefined && { enqueuer: deps.enqueuer }),
    ...(deps.priorReplans !== undefined && { priorReplans: deps.priorReplans }),
  });
}

describe("base-shift / percolation replan routing (v35 — a routed replan ACTUALLY RUNS, never stalls)", () => {
  it("ENQUEUES a re-plan run, re-opens the spec to `open`, and emits recovery.replan_queued (not in_flight, not event-only)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer("run_replan_xyz");
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: counterReturning(0) });

    await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new): the rebase conflict could not be resolved",
      otherSpecId: "spec_a",
    });

    // THE FIX (1): a fresh re-plan run was ENQUEUED — the routed replan re-authors the
    // work on the new base (never-discard), so the spec re-drives instead of stalling.
    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.calls[0]).toMatchObject({ specId: "spec_b", orgId: ORG, projectId: PROJECT });
    // (2) re-opened to the RE-DRIVABLE `open` status — NOT `in_flight` (the dead end the
    // walker reads as occupying a slot, which the run-create claim cannot take).
    expect(enqueuer.calls[0]?.reopenStatus).toBe("open");

    // (3) the durable replan-context event is appended (the carrier the next planner reads),
    // carrying the re-drivable status — NOT `in_flight`.
    const routed = eventStore.events.find((e) => e.eventType === "merge.conflict.replan_routed");
    expect(routed?.specId).toBe("spec_b");
    expect(payloadOf(eventStore.events, "merge.conflict.replan_routed").replanStatus).toBe("open");

    // (4) THE OBSERVABLE PROOF the replan RAN: `recovery.replan_queued` with the replanRunId.
    const queued = payloadOf(eventStore.events, "recovery.replan_queued");
    expect(queued.replanRunId).toBe("run_replan_xyz");
    expect(queued.plannerTaskId).toBe("task_run_replan_xyz");
    expect(queued.action).toBe("replan_with_steering");

    // The spec was NEVER routed back to `in_flight` (the stall state).
    expect(pool.statusWrites.some((w) => w.status === "in_flight")).toBe(false);
  });

  it("the re-plan carries the replan CONTEXT as steering (intent stays alive)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: counterReturning(0) });
    const context = "re-plan ON TOP OF spec_a (sha-new): the rebased branch failed its re-gate on the shifted base";

    await router.routeBackToPlanner({ specId: "spec_b", newContext: context, otherSpecId: "spec_a" });

    // The enqueuer received the context as the steering note → the next planner re-authors
    // the spec's work ON the new base (the intent + the new-base context, not discarded).
    expect(enqueuer.calls[0]?.steeringNote).toBe(context);
    expect(payloadOf(eventStore.events, "recovery.replan_queued").steeringNote).toBe(context);
  });

  it("BOUNDED: after MAX_BASE_SHIFT_REPLANS attempts it ESCALATES as needs_attention — no re-plan, no hot-loop", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    // Already routed the cap number of times — the next routing must escalate, not re-plan.
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: counterReturning(MAX_BASE_SHIFT_REPLANS) });

    await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "the rebase conflict could not be resolved (again)",
      otherSpecId: "spec_a",
    });

    // It did NOT enqueue yet another doomed re-plan (no hot-loop).
    expect(enqueuer.calls).toHaveLength(0);
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
    // It parked the spec `needs_attention` (frees the slot, blocks only dependents).
    expect(pool.statusWrites).toContainEqual({ specId: "spec_b", status: "needs_attention" });
    const escalation = payloadOf(eventStore.events, "dag.spec.needs_attention");
    expect(escalation.source).toBe("strand");
    expect(escalation.reason).toBe("human_decision");
    expect(escalation.attempts).toBe(MAX_BASE_SHIFT_REPLANS);
  });
});
