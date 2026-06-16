// The replan router (autonomy-engine.md §2b — "intent stays alive"). On an
// irreconcilable conflict (or a resolution / re-gate that fails on a shifted base),
// ONE spec is routed back to the planner with the OTHER spec's change as new context
// — so the intent is RE-PLANNED, never silently dropped or merged.
//
// CRITICAL (v35 — the replan-routed-but-never-executed stall): routing a spec back to
// the planner is NOT just a status flip + an event. A routed spec must ACTUALLY RE-DRIVE
// — a fresh re-plan run has to be ENQUEUED, or the spec sits forever in a state the
// walker reads as "occupying a slot" with no live run (the confirmed stall: the timeline
// ends at `merge.conflict.replan_routed → merge.dequeued`, then nothing, with NO
// `recovery.replan_queued` and the spec never re-driven). The old impl set the spec to
// `in_flight` — which `classifySpecStatus` maps to the `in_flight` scheduling bucket, so
// the walker NEVER re-enqueues it, AND `createQueuedRunFromSpec`'s claim only fires on an
// `open` spec — a dead end. This router now does the SAME thing the recovery
// `replan_with_steering` action does (the proven re-author-on-the-new-base mechanism):
//   (1) re-open the spec to `open` (the re-drivable status — the walker enqueues it AND
//       the run-create claim can take it) and append the replan context as steering on
//       the spec, so the next planner pass re-authors the work ON the new base (intent
//       stays alive — never-discard);
//   (2) ENQUEUE a fresh re-plan run (the same `createQueuedRunFromSpec` the walker/recovery
//       use) and emit `recovery.replan_queued` (carrying the `replanRunId`) so the re-plan
//       is OBSERVABLE — never a silent stall;
//   (3) append the durable `merge.conflict.replan_routed` context event the next planner
//       pass reads.
//
// BOUNDED (never an infinite re-plan hot-loop, no wall-clock deadline): a spec that has
// already been routed `MAX_BASE_SHIFT_REPLANS` times and STILL cannot be re-planned onto
// the shifted base is GENUINELY stuck — re-planning again would just re-conflict forever.
// At/over the cap this ESCALATES as a LOUD `needs_attention` human decision (frees the
// slot, blocks only dependents) instead of enqueuing yet another run — never a silent
// stall, never a hot-loop. It routes the status write through the run-state writer when
// wired (remote control plane) and otherwise runs the in-process org-scoped UPDATE.

import type pg from "pg";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { EventStore } from "../../../eventStore.js";
import type { ReplanRouter } from "../../../contracts/conflictResolution.js";
import { createLogger } from "../../../observability/logger.js";

const log = createLogger("replan-router");

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The bounded base-shift / percolation RE-PLAN budget: a spec whose work cannot be
 * re-planned onto the shifted base is routed back to the planner AT MOST this many
 * times. Once the count of prior `merge.conflict.replan_routed` events for the spec
 * REACHES this (`>=`), the next routing ESCALATES to `needs_attention` instead of
 * enqueuing another re-plan — so a spec is re-planned at most `MAX_BASE_SHIFT_REPLANS`
 * times, then surfaces a loud "this work cannot be re-planned onto the new base" human
 * decision (never an infinite re-plan hot-loop, never a wall-clock deadline).
 *
 * It mirrors the drive-path `MAX_CONFLICT_REPLANS` cap (same event, same bound key) so
 * BOTH replan routes — the drive-path resolver AND the base-shift coordinator — are
 * bounded by the same convention.
 */
export const MAX_BASE_SHIFT_REPLANS = 3;

/**
 * Enqueue a fresh re-plan run for the (now-re-opened) spec — the never-discard
 * re-author. Production wires `createQueuedRunFromSpec` (in-process) or the control-
 * plane `RunStateWriter.createQueuedRun`; a test injects a recording enqueuer. Returns
 * the new run id (the `replanRunId` the `recovery.replan_queued` event carries).
 */
export interface ReplanEnqueuer {
  enqueue(input: {
    specId: string;
    orgId: string;
    projectId: string;
    /** The replan context appended to the spec as steering (the next planner re-authors on it). */
    steeringNote: string;
    /** The re-drivable status to re-open the spec to before the run-create claims it. */
    reopenStatus: string;
  }): Promise<{ replanRunId: string; plannerTaskId: string }>;
}

/**
 * Count the spec's prior `merge.conflict.replan_routed` events (the bounded-replan
 * budget key). Production reads the `events` table org-scoped; a test injects a count.
 */
export interface PriorReplanCounter {
  count(input: { specId: string; orgId: string }): Promise<number>;
}

export interface SpecStatusReplanRouterDeps {
  pool: QueryClient;
  runStateWriter?: RunStateWriter;
  orgId?: string;
  eventStore: EventStore;
  runId: string;
  projectId: string;
  /**
   * Enqueues the re-plan run (never-discard re-author on the new base). REQUIRED to
   * actually re-drive: when absent the router only flips status + records the context
   * (the legacy no-run-enqueued behavior) — wiring it is what makes a routed replan RUN.
   */
  enqueuer?: ReplanEnqueuer;
  /** Reads the spec's prior replan count (the bounded-replan budget). */
  priorReplans?: PriorReplanCounter;
  /** The status a routed-back spec returns to so it can be re-driven (default `open`). */
  replanStatus?: string;
}

export class SpecStatusReplanRouter implements ReplanRouter {
  constructor(private readonly deps: SpecStatusReplanRouterDeps) {}

  async routeBackToPlanner(input: { specId: string; newContext: string; otherSpecId?: string }): Promise<void> {
    // BOUNDED (no hot-loop): a spec already routed `MAX_BASE_SHIFT_REPLANS` times that
    // STILL cannot be re-planned onto the shifted base is genuinely stuck — escalate as
    // a LOUD human decision instead of enqueuing yet another doomed re-plan.
    const priorReplans = this.deps.priorReplans
      ? await this.deps.priorReplans.count({ specId: input.specId, orgId: this.deps.orgId ?? "" })
      : 0;
    if (priorReplans >= MAX_BASE_SHIFT_REPLANS) {
      await this.escalate(input, priorReplans);
      return;
    }

    // (1)+(2) Re-open the spec to the re-drivable `open` status (the status the walker
    //     enqueues AND the run-create claim can take — `in_flight` is a DEAD END here),
    //     append the replan context as steering so the next planner pass re-authors the
    //     work ON the new base (intent stays alive), and ENQUEUE the fresh re-plan run.
    //     The enqueuer owns the re-open + steering + run-create as ONE ordered unit (the
    //     re-open must COMMIT before the run-create's separate-connection claim reads it —
    //     the same ordering the recovery `replan_with_steering` action documents). When no
    //     enqueuer is wired (a degenerate/test path) we fall back to a plain status flip.
    const status = this.deps.replanStatus ?? "open";
    const enqueued = await this.enqueueReplan(input, status);
    if (enqueued === undefined && this.deps.enqueuer === undefined) {
      // Legacy/degenerate path (no enqueuer): at least flip the status so the spec is not
      // stranded — but this path NEVER enqueues a run; production always wires the enqueuer.
      await this.setSpecStatus(input.specId, status);
    }

    // (3) Record the new planning context so the next planner pass re-authors the spec ON
    //     TOP of the other's change — the durable carrier that keeps intent alive.
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      eventType: "merge.conflict.replan_routed",
      payload: {
        specId: input.specId,
        ...(input.otherSpecId !== undefined && { otherSpecId: input.otherSpecId }),
        newContext: input.newContext,
        replanStatus: status,
      },
    });

    // (4) Emit the OBSERVABLE `recovery.replan_queued` so the routed replan is never a
    //     silent stall — it names the `replanRunId` the walker/worker will drive.
    if (enqueued !== undefined) {
      await this.deps.eventStore.append({
        runId: this.deps.runId,
        specId: input.specId,
        projectId: this.deps.projectId,
        eventType: "recovery.replan_queued",
        payload: {
          runId: this.deps.runId,
          specId: input.specId,
          action: "replan_with_steering",
          steeringNote: input.newContext,
          replanRunId: enqueued.replanRunId,
          plannerTaskId: enqueued.plannerTaskId,
        },
      });
    }
  }

  /**
   * Enqueue the re-plan run — the never-discard re-author of the spec's work on the new
   * base. Returns the new run id, or `undefined` when no enqueuer is wired (the legacy
   * status-only path). A re-open race (a concurrent tick already claimed the now-`open`
   * spec) is benign — the spec IS being re-driven, so we log it and skip the duplicate.
   */
  private async enqueueReplan(
    input: { specId: string; newContext: string },
    status: string,
  ): Promise<{ replanRunId: string; plannerTaskId: string } | undefined> {
    if (this.deps.enqueuer === undefined || this.deps.orgId === undefined) return undefined;
    try {
      return await this.deps.enqueuer.enqueue({
        specId: input.specId,
        orgId: this.deps.orgId,
        projectId: this.deps.projectId,
        steeringNote: input.newContext,
        reopenStatus: status,
      });
    } catch (error) {
      log.warn(
        "re-plan enqueue did not create a new run (a concurrent tick may have already claimed the re-opened spec) — the spec is re-drivable; the next walk re-enqueues it",
        { specId: input.specId },
        error,
      );
      return undefined;
    }
  }

  /**
   * ESCALATE: the spec has been re-planned the bounded number of times and STILL cannot
   * be re-planned onto the shifted base — park it `needs_attention` (frees the slot,
   * blocks only dependents) with a LOUD human-decision ask. NEVER another silent re-plan.
   */
  private async escalate(input: { specId: string; newContext: string }, priorReplans: number): Promise<void> {
    await this.setSpecStatus(input.specId, "needs_attention");
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "strand",
        specId: input.specId,
        reason: "human_decision",
        terminalRuns: [{ runId: this.deps.runId, status: "halted" }],
        attempts: priorReplans,
        message:
          `the autonomous self-heal could not re-plan this spec onto the shifted base: it has been ` +
          `re-planned ${priorReplans} times and the work STILL does not fit the new base — a human must ` +
          `decide how to proceed (re-scope the spec, or accept it cannot land on this base). ${input.newContext}`,
      },
    });
  }

  /** Set the spec status through the control plane when wired, else the in-process UPDATE. */
  private async setSpecStatus(specId: string, status: string): Promise<void> {
    if (this.deps.runStateWriter !== undefined && this.deps.orgId !== undefined) {
      await this.deps.runStateWriter.setSpecStatus({ specId, orgId: this.deps.orgId, status });
    } else {
      await this.deps.pool.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [specId, status]);
    }
  }
}
