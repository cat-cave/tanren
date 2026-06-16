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
import { SpecNotRunnableError } from "../../projectSpecErrors.js";
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
    const enqueue = await this.enqueueReplan(input, status);
    if (enqueue.outcome === "no-enqueuer") {
      // Legacy/degenerate path (no enqueuer wired): at least flip the status so the spec is
      // not stranded — but this path NEVER enqueues a run; production always wires the
      // enqueuer. The status flip alone keeps the spec re-drivable (it is `open`), but it
      // does NOT record a routing — so it cannot strand at `replan_routed` with no run.
      await this.setSpecStatus(input.specId, status);
      return;
    }
    if (enqueue.outcome === "failed") {
      // NEVER-STRAND (the v35 silent-fallback bug): the enqueue genuinely FAILED and NO run
      // is being driven for the spec. The old code swallowed this and STILL emitted
      // `merge.conflict.replan_routed` (counting against the bounded cap) with NO
      // `recovery.replan_queued` and no live run — the exact `replanned`-strand the live
      // run hit (the spec sat `in_flight`/`open` forever). A routed replan that cannot RUN
      // is not a recoverable re-plan; it is a genuine failure a human must see. Escalate
      // LOUDLY (frees the slot, blocks only dependents) instead of recording a bare routing.
      await this.escalateEnqueueFailure(input, enqueue.error);
      return;
    }

    // (3) Record the new planning context so the next planner pass re-authors the spec ON
    //     TOP of the other's change — the durable carrier that keeps intent alive. Emitted
    //     ONLY now that a re-drive is CONFIRMED (a fresh run was enqueued, or a concurrent
    //     tick already claimed the re-opened spec → a run IS in flight) — so a recorded
    //     `replan_routed` ALWAYS corresponds to a spec that is actually being re-driven,
    //     never a silent strand. The bounded cap counts these, so it counts only real routings.
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
    //     silent stall — it names the `replanRunId` the walker/worker will drive. Only the
    //     `enqueued` outcome created a NEW run (the observable id); the benign already-claimed
    //     race did NOT create a run (a concurrent tick owns the live re-drive), so there is no
    //     new run id to name — the `replan_routed` routing above already marks it observable,
    //     and the concurrent tick emitted its own `run.queued`. No fabricated run id ever.
    if (enqueue.outcome === "enqueued") {
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
          replanRunId: enqueue.replanRunId,
          plannerTaskId: enqueue.plannerTaskId,
        },
      });
    }
  }

  /**
   * Enqueue the re-plan run — the never-discard re-author of the spec's work on the new
   * base. The outcome the caller routes on:
   *   - `enqueued`       — a fresh re-plan run was created (the `replanRunId` is observable);
   *   - `already-running` — a concurrent tick already claimed the re-opened spec
   *                         (`SpecNotRunnableError`): a run IS being driven, so this is a
   *                         BENIGN no-op, NOT a strand (the spec re-drives on the live run);
   *   - `failed`         — a GENUINE enqueue failure with no run in flight (must escalate,
   *                         never silently strand the spec at `replan_routed`);
   *   - `no-enqueuer`    — no enqueuer wired (the degenerate/test status-only path).
   */
  private async enqueueReplan(
    input: { specId: string; newContext: string },
    status: string,
  ): Promise<
    | { outcome: "enqueued"; replanRunId: string; plannerTaskId: string }
    | { outcome: "already-running" }
    | { outcome: "failed"; error: unknown }
    | { outcome: "no-enqueuer" }
  > {
    if (this.deps.enqueuer === undefined || this.deps.orgId === undefined) return { outcome: "no-enqueuer" };
    try {
      const run = await this.deps.enqueuer.enqueue({
        specId: input.specId,
        orgId: this.deps.orgId,
        projectId: this.deps.projectId,
        steeringNote: input.newContext,
        reopenStatus: status,
      });
      return { outcome: "enqueued", replanRunId: run.replanRunId, plannerTaskId: run.plannerTaskId };
    } catch (error) {
      // BENIGN RACE ONLY: the re-opened spec was already claimed by a concurrent tick (the
      // run-create's `open`-status claim found it taken). The spec IS being re-driven on
      // that run, so this is not a strand — log + treat as a confirmed re-drive.
      if (error instanceof SpecNotRunnableError) {
        log.warn(
          "re-plan enqueue found the re-opened spec already claimed by a concurrent tick — the spec is being re-driven on that run; skipping the duplicate enqueue",
          { specId: input.specId },
          error,
        );
        return { outcome: "already-running" };
      }
      // GENUINE FAILURE: the enqueue could not create a run AND no concurrent tick owns it.
      // Surface it so the caller escalates — NEVER swallow it into a silent strand.
      log.error(
        "re-plan enqueue FAILED to create a run for the routed spec — escalating (never a silent replan_routed strand)",
        { specId: input.specId },
        error,
      );
      return { outcome: "failed", error };
    }
  }

  /**
   * ESCALATE an enqueue failure: a routed replan whose run could not be created (and no
   * concurrent tick owns it) is genuinely stuck — park it `needs_attention` (frees the slot,
   * blocks only dependents) with a LOUD ask. NEVER a bare `replan_routed` strand with no run.
   */
  private async escalateEnqueueFailure(input: { specId: string; newContext: string }, error: unknown): Promise<void> {
    await this.setSpecStatus(input.specId, "needs_attention");
    const detail = error instanceof Error ? error.message : String(error);
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "strand",
        specId: input.specId,
        // The self-heal MECHANISM failed (the re-plan run could not be created) — a
        // genuinely stuck spec, not a product/merge decision: `persistent_failure`.
        reason: "persistent_failure",
        terminalRuns: [{ runId: this.deps.runId, status: "halted" }],
        attempts: 0,
        message:
          `the autonomous self-heal routed this spec back to the planner but could NOT enqueue the ` +
          `re-plan run (${detail}) — the spec cannot re-drive on its own, so a human must intervene ` +
          `instead of letting it strand. ${input.newContext}`,
      },
    });
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
