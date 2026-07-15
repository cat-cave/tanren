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
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type pg from "pg";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";
import {
  AlreadyClaimedEnqueuer,
  PrepareFailEnqueuer,
  RecordingEnqueuer,
  RecordingEventStore,
  RecordingPool,
} from "./fixtures/dagBaseShiftReplanFixtures.js";

/** An enqueuer that FAILS genuinely (no run created, no concurrent tick owns the spec). */
class FailingEnqueuer implements ReplanEnqueuer {
  calls = 0;
  constructor(private readonly error: Error = new Error("run-create connection refused")) {}
  async enqueue(): Promise<{ replanRunId: string; plannerTaskId: string }> {
    this.calls += 1;
    throw this.error;
  }
}
import {
  conflictSignatureOf,
  type PriorReplanReader,
  type ReplanEnqueuer,
  SpecStatusReplanRouter,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const ORG = "org_replan";
const PROJECT = "project_replan";

/** A scripted prior-replan reader returning the given conflict signatures (the detector input). */
function readerReturning(signatures: string[]): PriorReplanReader {
  return { signatures: async () => signatures };
}

/** No prior re-plans (the first routing — always PROGRESS, re-drive). */
const noPriorReplans = readerReturning([]);

/** Find the (asserted-present) event of a type and return its payload as a record. */
function payloadOf(events: AppendEventInput[], eventType: string): Record<string, unknown> {
  const event = events.find((e) => e.eventType === eventType);
  expect(event).toBeDefined();
  return (event as AppendEventInput).payload as Record<string, unknown>;
}

function buildRouter(deps: {
  pool: RecordingPool;
  eventStore: RecordingEventStore;
  enqueuer?: ReplanEnqueuer;
  priorReplans?: PriorReplanReader;
  /** Scripted current status for atomic park notFromStatuses + durable readback (default open). */
  specStatus?: string;
}): SpecStatusReplanRouter {
  const status = deps.specStatus ?? "open";
  deps.pool.defaultSpecStatus = status;
  const writer = new InMemoryRunStateWriter({
    forwardSetSpecStatus: (input) => {
      deps.pool.statusWrites.push({ specId: input.specId, status: input.status });
    },
    // Atomic park: status flip + park event only when the guard allows a row move.
    forwardUpdateSpecWithEvent: (input) => {
      deps.pool.statusWrites.push({ specId: input.spec.specId, status: input.spec.status });
    },
    forwardAppend: (event) => {
      void deps.eventStore.append(event);
    },
  });
  writer.updateSpecCurrentStatus = status;
  return new SpecStatusReplanRouter({
    pool: deps.pool as unknown as pg.Pool,
    runStateWriter: writer,
    orgId: ORG,
    eventStore: deps.eventStore,
    runId: "run_b",
    projectId: PROJECT,
    ...(deps.enqueuer !== undefined && { enqueuer: deps.enqueuer }),
    ...(deps.priorReplans !== undefined && { priorReplans: deps.priorReplans }),
  });
}

describe("conflictSignatureOf", () => {
  it("hashes a real NUL field boundary deterministically instead of concatenating ambiguous inputs", () => {
    const aThenBc = conflictSignatureOf("bc", "a");
    const abThenC = conflictSignatureOf("c", "ab");

    expect(aThenBc).toBe("40bb547d936bbd31318ee37ac8799e7ecbb22eda2651f65e3214bffb8ce97bb4");
    expect(abThenC).toBe("6c032e631d39a14d85aff7e319546af701e26c97b57ca95fbfe9c6ba855f67bf");
    expect(aThenBc).not.toBe(abThenC);
    expect(conflictSignatureOf("bc", "a")).toBe(aThenBc);
  });
});

describe("base-shift / percolation replan routing (v35 — a routed replan ACTUALLY RUNS, never stalls)", () => {
  it("ENQUEUES a re-plan run, re-opens the spec to `open`, and emits recovery.replan_queued (not in_flight, not event-only)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer("run_replan_xyz");
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new): the rebase conflict could not be resolved",
      otherSpecId: "spec_a",
    });

    expect(recovery).toEqual({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "enqueued", replanRunId: "run_replan_xyz", plannerTaskId: "task_run_replan_xyz" },
      },
    });

    // THE FIX (1): a fresh re-plan run was ENQUEUED — the routed replan re-authors the
    // work on the new base (never-discard), so the spec re-drives instead of stalling.
    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.calls[0]).toMatchObject({ specId: "spec_b", orgId: ORG, projectId: PROJECT });
    // (2) re-opened to the RE-DRIVABLE `open` status — NOT `in_flight` (the dead end the
    // walker reads as occupying a slot, which the run-create claim cannot take).
    expect(enqueuer.calls[0]?.steeringNote).toContain("re-plan ON TOP OF");

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
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });
    const context = "re-plan ON TOP OF spec_a (sha-new): the rebased branch failed its re-gate on the shifted base";

    await router.routeBackToPlanner({ specId: "spec_b", newContext: context, otherSpecId: "spec_a" });

    // The enqueuer received the context as the steering note → the next planner re-authors
    // the spec's work ON the new base (the intent + the new-base context, not discarded).
    expect(enqueuer.calls[0]?.steeringNote).toBe(context);
    expect(payloadOf(eventStore.events, "recovery.replan_queued").steeringNote).toBe(context);
  });

  it("FIXED POINT: re-planning against the SAME conflict again ESCALATES as needs_attention — no re-plan, no hot-loop, no count", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new RecordingEnqueuer();
    const sameContext = "the rebase conflict could not be resolved (again)";
    // The spec was re-planned against this EXACT conflict REPEATEDLY (the identical conflict
    // recurring beyond a single transient repeat = a proven cycle) — re-planning again would
    // re-conflict identically (a fixed point). The detector escalates, regardless of count.
    const router = buildRouter({
      pool,
      eventStore,
      enqueuer,
      priorReplans: readerReturning([
        conflictSignatureOf(sameContext, "spec_a"),
        conflictSignatureOf(sameContext, "spec_a"),
      ]),
    });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: sameContext,
      otherSpecId: "spec_a",
    });

    expect(recovery).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_b", source: "planner_replan" },
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
  // `merge.conflict.replan_routed` with NO `recovery.replan_queued` and no live run — the
  // exact `replanned`-strand the live run hit (a spec stuck >1h, no re-plan). A routed replan
  // that cannot RUN must ESCALATE loudly, never record a bare routing that strands.
  it("NEVER-STRAND: a GENUINE enqueue failure ESCALATES (needs_attention) — never a bare replan_routed strand", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new FailingEnqueuer(new Error("run-create connection refused"));
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    expect(recovery).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_b", source: "planner_replan" },
    });

    // The enqueue WAS attempted (the never-discard re-author was tried).
    expect(enqueuer.calls).toBe(1);
    // THE FIX: NO bare `replan_routed` strand — a routing that cannot run is not recorded as a
    // (cap-counting) routing, and NO `recovery.replan_queued` claims a run that does not exist.
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    // Instead it ESCALATES loudly so a human sees the stuck spec (frees the slot).
    expect(pool.statusWrites).toContainEqual({ specId: "spec_b", status: "needs_attention" });
    const escalation = payloadOf(eventStore.events, "dag.spec.needs_attention");
    expect(escalation.source).toBe("strand");
    expect(escalation.reason).toBe("persistent_failure");
    expect(String(escalation.message)).toMatch(/could NOT enqueue the re-plan run/u);
    expect(String(escalation.message)).toMatch(/connection refused/u);
  });

  // The BENIGN race (a concurrent tick already claimed the re-opened spec): the spec IS being
  // re-driven on that run, so this is NOT a strand — the routing is recorded (observable; the
  // concurrent tick emitted its own `run.queued`), but it does NOT escalate (no human needed)
  // and emits NO `recovery.replan_queued` (no NEW run id to name — never a fabricated id).
  it("BENIGN race: an already-claimed spec records the routing, emits no fake replan_queued, does NOT escalate", async () => {
    const pool = new RecordingPool();
    // Independent live-run proof required — SpecNotRunnableError alone is never ownership.
    pool.liveRunsBySpec.set("spec_b", { run_id: "run_concurrent_b", status: "running" });
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    expect(recovery).toEqual({
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: "spec_b",
        run: { kind: "already_running", runId: "run_concurrent_b" },
      },
    });

    expect(enqueuer.calls).toBe(1);
    // The routing IS recorded + observable (a run IS being driven for the spec).
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(true);
    // No `recovery.replan_queued` with a fabricated run id (no NEW run was created here).
    expect(eventStore.events.some((e) => e.eventType === "recovery.replan_queued")).toBe(false);
    // It does NOT escalate (the spec is re-driving on the concurrent run, not stuck).
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
    expect(pool.statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
  });

  it("FAIL-CLOSED: SpecNotRunnableError without a live, in-progress run parks (never fabricates already_running)", async () => {
    const pool = new RecordingPool();
    // No liveRunsBySpec entry — claim race without a proven live run.
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan ON TOP OF spec_a (sha-new)",
      otherSpecId: "spec_a",
    });

    expect(recovery.kind).toBe("parked");
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(true);
    expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
  });

  it.each([
    {
      status: "merged" as const,
      seedStatus: "merged",
      match: { kind: "terminal_noop" as const, status: "merged" as const },
      parkEvent: false,
    },
    {
      status: "cancelled" as const,
      seedStatus: "cancelled",
      match: { kind: "terminal_noop" as const, status: "cancelled" as const },
      parkEvent: false,
    },
    {
      status: "halted" as const,
      seedStatus: "halted",
      match: { kind: "terminal_noop" as const, status: "halted" as const },
      parkEvent: false,
    },
    {
      status: "needs_attention" as const,
      seedStatus: "needs_attention",
      match: { kind: "parked" as const },
      parkEvent: false,
    },
    {
      status: "weird_status" as const,
      seedStatus: "in_flight",
      match: { kind: "parked" as const },
      parkEvent: true,
    },
  ])(
    "FAIL-CLOSED: prepare-refused $status → $match.kind (parkEvent=$parkEvent)",
    async ({ status, seedStatus, match, parkEvent }) => {
      const pool = new RecordingPool();
      const eventStore = new RecordingEventStore();
      const enqueuer = new PrepareFailEnqueuer("not_recoverable", status);
      const router = buildRouter({
        pool,
        eventStore,
        enqueuer,
        priorReplans: noPriorReplans,
        specStatus: seedStatus,
      });
      const recovery = await router.routeBackToPlanner({
        specId: `spec_${status}`,
        newContext: "re-plan non-recoverable",
      });
      expect(enqueuer.calls).toHaveLength(1);
      expect(eventStore.events.some((e) => e.eventType === "merge.conflict.replan_routed")).toBe(false);
      expect(recovery).toMatchObject(match);
      expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(parkEvent);
    },
  );

  it("ATOMIC park: already-merged concurrent terminal is terminal_noop (zero flip, zero park event)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new FailingEnqueuer();
    const router = buildRouter({
      pool,
      eventStore,
      enqueuer,
      priorReplans: noPriorReplans,
      specStatus: "merged",
    });
    const recovery = await router.routeBackToPlanner({
      specId: "spec_merged",
      newContext: "re-plan after enqueue fail",
    });
    expect(recovery).toMatchObject({ kind: "terminal_noop", status: "merged" });
    expect(pool.statusWrites.some((w) => w.status === "needs_attention")).toBe(false);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  it("ATOMIC park: concurrent cancel is terminal_noop (zero status change, zero park event)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new FailingEnqueuer();
    const router = buildRouter({
      pool,
      eventStore,
      enqueuer,
      priorReplans: noPriorReplans,
      specStatus: "cancelled",
    });
    const recovery = await router.routeBackToPlanner({
      specId: "spec_cancelled",
      newContext: "re-plan after enqueue fail",
    });
    expect(recovery).toMatchObject({ kind: "terminal_noop", status: "cancelled" });
    expect(pool.statusWrites).toEqual([]);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  it("ATOMIC park: already needs_attention is parked only after durable readback (no second park event)", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new FailingEnqueuer();
    const router = buildRouter({
      pool,
      eventStore,
      enqueuer,
      priorReplans: noPriorReplans,
      specStatus: "needs_attention",
    });
    const recovery = await router.routeBackToPlanner({
      specId: "spec_parked",
      newContext: "re-plan after enqueue fail",
    });
    expect(recovery).toMatchObject({
      kind: "parked",
      receipt: { kind: "needs_attention", specId: "spec_parked", source: "planner_replan" },
    });
    expect(pool.statusWrites).toHaveLength(0);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(false);
  });

  it("FAIL-CLOSED: missing-spec prepare parks", async () => {
    const pool = new RecordingPool();
    const eventStore = new RecordingEventStore();
    const enqueuer = new PrepareFailEnqueuer("missing");
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });
    const recovery = await router.routeBackToPlanner({
      specId: "spec_absent",
      newContext: "missing",
    });
    expect(recovery.kind).toBe("parked");
    expect(String((recovery as { message: string }).message)).toMatch(/missing/u);
  });

  it("FAIL-CLOSED: a halted run is not an active owner for already_running", async () => {
    const pool = new RecordingPool();
    pool.liveRunsBySpec.set("spec_b", { run_id: "run_halted", status: "halted" });
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });

    const recovery = await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan",
      otherSpecId: "spec_a",
    });

    expect(recovery.kind).toBe("parked");
    // org-scoped read must open a txn with SET LOCAL
    expect(pool.scopeOps.some((o) => o.startsWith("SET LOCAL"))).toBe(true);
    expect(eventStore.events.some((e) => e.eventType === "dag.spec.needs_attention")).toBe(true);
  });

  it("org-scopes active-owner proof with BEGIN/SET LOCAL/COMMIT", async () => {
    const pool = new RecordingPool();
    pool.liveRunsBySpec.set("spec_b", { run_id: "run_concurrent_b", status: "running" });
    const eventStore = new RecordingEventStore();
    const enqueuer = new AlreadyClaimedEnqueuer();
    const router = buildRouter({ pool, eventStore, enqueuer, priorReplans: noPriorReplans });
    await router.routeBackToPlanner({
      specId: "spec_b",
      newContext: "re-plan",
      otherSpecId: "spec_a",
    });
    expect(pool.scopeOps).toEqual(expect.arrayContaining(["BEGIN", expect.stringMatching(/^SET LOCAL/u), "COMMIT"]));
  });
});
