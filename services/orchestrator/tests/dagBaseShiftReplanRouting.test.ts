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
import { SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";
import {
  conflictSignatureOf,
  type PriorReplanReader,
  type ReplanEnqueuer,
  SpecStatusReplanRouter,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const ORG = "org_replan";
const PROJECT = "project_replan";

/**
 * Pool-capable double for active-owner proof (findActiveOwnerRunForSpec → runWithOrgScope).
 * Must expose connect (isPool narrow); scripts active-owner rows for SpecNotRunnableError.
 */
class RecordingPool {
  readonly statusWrites: Array<{ specId: string; status: string }> = [];
  /** When set, SpecNotRunnableError path finds this active owner run. */
  activeOwner: { runId: string; status: string } | undefined;
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (text.startsWith("UPDATE specs SET status")) {
      this.statusWrites.push({ specId: String(params?.[0]), status: String(params?.[1]) });
      return { rows: [] };
    }
    if (text.includes("FROM runs") && text.includes("status IN")) {
      if (this.activeOwner === undefined) return { rows: [] };
      return { rows: [{ run_id: this.activeOwner.runId, status: this.activeOwner.status }] };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SET LOCAL")) {
      return { rows: [] };
    }
    throw new Error(`unexpected pool query in replan-routing test: ${text}`);
  }
  async connect(): Promise<{ query: RecordingPool["query"]; release: () => void }> {
    return { query: this.query.bind(this), release: () => {} };
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

/** An enqueuer that THROWS the benign already-claimed race (a concurrent tick took the spec). */
class AlreadyClaimedEnqueuer implements ReplanEnqueuer {
  calls = 0;
  async enqueue(input: { specId: string }): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls += 1;
    throw new SpecNotRunnableError(input.specId, "in_flight");
  }
}

/** An enqueuer that FAILS genuinely (no run created, no concurrent tick owns the spec). */
class FailingEnqueuer implements ReplanEnqueuer {
  calls = 0;
  constructor(private readonly error: Error = new Error("run-create connection refused")) {}
  async enqueue(): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls += 1;
    throw this.error;
  }
}

/** A scripted prior-replan reader returning the given conflict signatures (the detector input). */
function readerReturning(signatures: string[]): PriorReplanReader {
  return { signatures: async () => signatures };
}

/** No prior re-plans (the first routing — always PROGRESS, re-drive). */
const noPriorReplans = readerReturning([]);

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
  priorReplans?: PriorReplanReader;
}): SpecStatusReplanRouter {
  // Audit D-R3.2: the writer is REQUIRED on `SpecStatusReplanRouter`. Forward the
  // writer's `setSpecStatus` into the recording pool's `statusWrites` array so the
  // existing assertions on "the spec was re-opened to `open` / escalated to
  // `needs_attention`" hold unchanged.
  const writer = new InMemoryRunStateWriter({
    forwardSetSpecStatus: (input) => {
      deps.pool.statusWrites.push({ specId: input.specId, status: input.status });
    },
  });
  return new SpecStatusReplanRouter({
    // RecordingPool is Pool-capable (connect + query); isPool accepts it without cast.
    pool: deps.pool,
    runStateWriter: writer,
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
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const result = await router.routeBackToPlanner({
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

    // (5) Typed owned receipt — never a bare void; settlement verifies this.
    expect(result).toEqual({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_replan_xyz", plannerTaskId: "task_run_replan_xyz" },
      },
    });

    // The spec was NEVER routed back to `in_flight` (the stall state).
    expect(pool.statusWrites.some((w) => w.status === "in_flight")).toBe(false);
  });

  it("the re-plan carries the replan CONTEXT as steering (intent stays alive)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });
    const context = "re-plan ON TOP OF spec_a (sha-new): the rebased branch failed its re-gate on the shifted base";

    await router.routeBackToPlanner({ specId: "spec_b", newContext: context, otherSpecId: "spec_a" });

    // The enqueuer received the context as the steering note → the next planner re-authors
    // the spec's work ON the new base (the intent + the new-base context, not discarded).
    expect(enqueuer.calls[0]?.steeringNote).toBe(context);
    expect(payloadOf(eventStore.events, "recovery.replan_queued").steeringNote).toBe(context);
  });

  it("FIXED POINT: re-planning against the SAME conflict again returns parking_required — no re-plan, no hot-loop, no count", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    const sameContext = "the rebase conflict could not be resolved (again)";
    // The spec was re-planned against this EXACT conflict REPEATEDLY (the identical conflict
    // recurring beyond a single transient repeat = a proven cycle) — re-planning again would
    // re-conflict identically (a fixed point). One-authority model: router returns
    // parking_required; settlement (RecoveryParkWriter) owns the park — never self-parks.
    const router = buildRouter({
      pool,
      eventStore,
      enqueuer,
      priorReplans: readerReturning([
        conflictSignatureOf(sameContext, "spec_a"),
        conflictSignatureOf(sameContext, "spec_a"),
      ]),
    });

    const result = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: sameContext,
      otherSpecId: "spec_a",
    });

    // It did NOT enqueue yet another doomed re-plan (no hot-loop).
    expect(enqueuer.calls).toHaveLength(0);
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
    // One-authority: router does NOT park needs_attention; settlement does.
    expect(result.kind).toBe("parking_required");
    expect(result.kind === "parking_required" && result.message).toMatch(/fixed point/u);
    expect(pool.statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  it("UNBOUNDED while PROGRESSING: re-planning against DIFFERENT conflicts keeps re-planning (far past any old cap)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    // Five prior re-plans, each against a DIFFERENT conflict (the base kept shifting — progress).
    const priorReplans = readerReturning(["c1", "c2", "c3", "c4", "c5"].map((c) => conflictSignatureOf(c, "spec_a")));
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans });

    await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "a brand-new conflict against a freshly-shifted base",
      otherSpecId: "spec_a",
    });

    // It re-planned (progress) — never escalated, no matter how many prior re-plans.
    expect(enqueuer.calls).toHaveLength(1);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  // THE v35 STRAND BUG (fixed): the enqueue could SWALLOW a genuine failure and STILL emit
  // `merge.conflict.replan_routed` with NO `recovery.replan_queued` and no live run.
  // One-authority: enqueue failure → parking_required (settlement parks), never bare replan_routed.
  it("NEVER-STRAND: a GENUINE enqueue failure returns parking_required — never a bare replan_routed strand", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new FailingEnqueuer(new Error("run-create connection refused"));
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const result = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    // The enqueue WAS attempted (the never-discard re-author was tried).
    expect(enqueuer.calls).toBe(1);
    // NO bare `replan_routed` strand and NO fabricated `recovery.replan_queued`.
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    // One-authority: parking_required so settlement parks atomically (router does not self-park).
    expect(result.kind).toBe("parking_required");
    expect(result.kind === "parking_required" && result.message).toMatch(/enqueue failed/u);
    expect(result.kind === "parking_required" && result.message).toMatch(/connection refused/u);
    expect(pool.statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  // The BENIGN race (a concurrent tick already claimed the re-opened spec): SpecNotRunnableError
  // with a verified active owner → owned already_running receipt (never fabricate ownership
  // from SpecNotRunnableError alone; findActiveOwnerRunForSpec must prove live run).
  it("BENIGN race: already-claimed with verified active owner → owned already_running, no fake replan_queued", async () => {
    const pool = new RecordingPool();
    pool.activeOwner = { runId: "run_concurrent", status: "running" };
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const result = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    expect(enqueuer.calls).toBe(1);
    // The routing IS recorded + observable (a run IS being driven for the spec).
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(true);
    // No `recovery.replan_queued` with a fabricated run id (no NEW run was created here).
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    expect(result).toEqual({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "already_running", runId: "run_concurrent" },
      },
    });
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
    expect(pool.statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
  });

  it("BENIGN race without active owner → parking_required (SpecNotRunnableError is never ownership)", async () => {
    const pool = new RecordingPool();
    // No activeOwner — SpecNotRunnableError alone fails closed.
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const result = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    expect(result.kind).toBe("parking_required");
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
  });
});
