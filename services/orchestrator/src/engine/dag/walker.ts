// The production DagWalker (autonomy-engine.md §1a keystone + §2c speculative
// execution). A per-project background SCHEDULER over the EXISTING run executor
// (it mirrors how the BenchmarkRunner schedules trials — it does NOT execute runs
// itself). Each tick it loads the spec DAG + the per-spec LIFECYCLE PROJECTION
// under RLS, plans the tick with the pure `planSpeculativeDagTick` core (readiness
// = all deps crossed the configured SPECULATION THRESHOLD, not just merged), and
// for each ready spec builds its speculative integration branch (when it has
// unmerged ancestors) and enqueues it against that DYNAMIC BASE through the SAME
// createQueuedRunFromSpec path a manual operator trigger uses. The parallel
// run-executor worker then runs them.
//
// The pg seam wirings (read model + lifecycle projection + enqueuer + event
// emitter) live in `walkerPg.ts`; the integration-branch builder is the
// `SpeculativeIntegrator` seam (`speculativeIntegrator.ts`). The LISTEN/NOTIFY
// subscriber that runs the walker on startup + on every run.*-terminal /
// merge.completed notification (incl. ancestor-merge → dependent re-gate) lives in
// `subscriber.ts`.

import { getSystemPool, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  DEFAULT_SPECULATION_THRESHOLD,
  DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
  resolveWorkerConcurrency,
  type SpeculationThreshold,
} from "../config/index.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import {
  type BudgetGate,
  type DagEnqueuer,
  type DagReadModel,
  type DagWalker,
  planSpeculativeDagTick,
  type PlannedEnqueue,
  type ProjectBudgetState,
  shouldPauseOnBudget,
  type WalkResult,
} from "../contracts/dagWalker.js";
import type { DagLifecycleReadModel } from "../contracts/dagLifecycle.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SpeculativeIntegrator } from "../contracts/speculativeIntegrator.js";
import { SpecDependenciesBlockedError, SpecNotRunnableError } from "../workflow/projectSpecErrors.js";
import type { SpecReadiness } from "./speculation.js";
import { PgBudgetGate } from "./budgetGate.js";
import { PgDagLifecycleReadModel } from "./lifecycle.js";
import { type DagEventEmitter, PgDagEventEmitter, PgDagReadModel, SpecRunDagEnqueuer } from "./walkerPg.js";

/** Resolve the governed concurrency ceiling — the config knob, never an env var. */
export type ConcurrencyResolver = () => number;

/** The per-project speculation config (autonomy-engine.md §2c): threshold + depth cap. */
export interface SpeculationConfig {
  threshold: SpeculationThreshold;
  depthCap: number;
}

/** Resolve a project's speculation config from its versioned config (never an env var). */
export type SpeculationConfigResolver = (projectId: string) => Promise<SpeculationConfig>;

export interface DagWalkerDeps {
  readModel: DagReadModel;
  /** P2c-1: the per-spec lifecycle projection the speculation threshold reasons over. */
  lifecycleReadModel: DagLifecycleReadModel;
  enqueuer: DagEnqueuer;
  events: DagEventEmitter;
  /**
   * The dollar-budget gate (autonomy-engine.md §3 proof 6): resolves the project's
   * configured ceiling (project-over-org) + cumulative spend over the period before
   * enqueuing. When the ceiling is reached the walk pauses on budget (enqueues
   * nothing, emits dag.budget.paused). A project with no budget configured resolves
   * `ceilingUsd: undefined` ⇒ unlimited ⇒ behavior byte-identical to today.
   */
  budgetGate: BudgetGate;
  /** P2c-1: builds a dependent's speculative integration branch (the dynamic base). */
  integrator: SpeculativeIntegrator;
  /** P2c-1: resolves the project's speculation threshold + depth cap from config. */
  speculationConfig: SpeculationConfigResolver;
  /**
   * The governed concurrency ceiling (autonomy-engine.md §1.4): defaults to the
   * config surface's `AllocatorConfig.concurrency` (the SAME ceiling the worker
   * boots with). Never read from `process.env`. A seam so a future per-project/org
   * resolver (and the live rate-limit/budget throttle) slots in without touching
   * the walk loop.
   */
  concurrency?: ConcurrencyResolver;
}

/**
 * The production DagWalker. `walk(projectId)` performs one full scheduling pass:
 * load the DAG + lifecycle snapshots under RLS → plan the tick with the pure
 * SPECULATIVE core (readiness = all deps crossed the configured threshold) → for
 * each ready spec, build its speculative integration branch (when it has unmerged
 * ancestors) and enqueue it against that dynamic base → emit the outcome event(s).
 * It never holds DAG state in memory across ticks (it reloads every walk), so the
 * DAG rows are always the source of truth. The subscriber drives it on startup +
 * on every relevant notification (incl. ancestor `merge.completed`, which re-walks
 * so a freshly-merged ancestor re-gates its dependents against reality — P2a).
 */
export class EventEmittingDagWalker implements DagWalker {
  private readonly concurrency: ConcurrencyResolver;

  constructor(private readonly deps: DagWalkerDeps) {
    this.concurrency = deps.concurrency ?? resolveWorkerConcurrency;
  }

  async walk(projectId: string): Promise<WalkResult> {
    const [snapshot, lifecycle, config, budget] = await Promise.all([
      this.deps.readModel.loadSnapshot(projectId),
      this.deps.lifecycleReadModel.loadLifecycle(projectId),
      this.deps.speculationConfig(projectId),
      this.deps.budgetGate.resolveBudget(projectId),
    ]);

    // The dollar-budget gate (autonomy-engine.md §3 proof 6 + BUDGET-SAFETY C1b/M5):
    // when the project's cumulative spend has reached the configured ceiling — OR the
    // gate must FAIL CLOSED (unpriced spend / unparseable config) — enqueue NOTHING
    // this tick and pause on budget. In-flight runs are NOT touched (they are bounded
    // by the escape hatches) — only NEW work stops. A project with no budget concern
    // (`ceilingUsd: undefined`, no failClosed) never hits this branch, so behavior is
    // byte-identical to before.
    if (shouldPauseOnBudget(budget)) {
      return this.pauseOnBudget(projectId, budget);
    }

    const ceiling = this.concurrency();
    const plan = planSpeculativeDagTick(snapshot, lifecycle, {
      concurrencyCeiling: ceiling,
      threshold: config.threshold,
      depthCap: config.depthCap,
    });

    // Surface every depth-capped HOLD (the "no silent caps" rule, §2c): the spec
    // is not enqueued this tick; the walker re-evaluates on the next ancestor merge.
    await this.emitHeld(projectId, plan.held);

    const enqueuedSpecIds: string[] = [];
    const enqueuedRunIds: string[] = [];

    if (plan.enqueues.length > 0) {
      const depsBySpec = new Map(snapshot.nodes.map((n) => [n.specId, n.dependsOn]));
      // inFlightBefore reflects the count at plan time PLUS the specs this walk has
      // already enqueued — the true headroom each spec scheduled into.
      let inFlightBefore = plan.inFlightCount;
      for (const enqueue of plan.enqueues) {
        const enqueued = await this.enqueueOne(
          projectId,
          enqueue,
          config.threshold,
          inFlightBefore,
          ceiling,
          depsBySpec,
        );
        if (enqueued === undefined) {
          // The spec was NOT enqueued this tick, for one of two benign reasons:
          //   - a speculative integration surfaced an ancestor-vs-ancestor conflict
          //     (the dependent is HELD — it cannot base on a broken integration —
          //     and the walker retries once the pair reconciles/merges); OR
          //   - a CONCURRENT tick already claimed it (SpecNotRunnableError — the
          //     pending→active claim is the idempotency boundary, so this is the
          //     expected, harmless concurrent-tick race, swallowed in enqueueOne).
          // Either way: skip it this tick, no error.
          continue;
        }
        enqueuedSpecIds.push(enqueue.specId);
        enqueuedRunIds.push(enqueued.runId);
        inFlightBefore += 1;
      }
    }

    if (enqueuedSpecIds.length === 0) {
      // The pure planner only ever yields concurrency_saturated (slot pressure) or
      // drained here — the genuine budget pause was already handled above the plan.
      if (plan.status === "concurrency_saturated") {
        await this.deps.events.emitConcurrencySaturated({ projectId, plan });
      } else {
        await this.deps.events.emitDrained({ projectId, plan });
      }
    }

    return {
      projectId,
      status: enqueuedSpecIds.length > 0 ? "enqueued" : plan.status,
      enqueuedSpecIds,
      enqueuedRunIds,
    };
  }

  /**
   * Pause the tick on the dollar-budget gate: enqueue nothing, emit dag.budget.paused
   * with the configured ceiling + the measured spend (+ the FAIL-CLOSED reason when
   * this is a safety pause), and return a `budget_paused` result. Reached on a genuine
   * ceiling-reached pause (ceiling defined) OR a fail-closed pause (BUDGET-SAFETY
   * C1b/M5 — `ceilingUsd` may be undefined when the config was unparseable, so it
   * defaults to 0 in the event).
   */
  private async pauseOnBudget(projectId: string, budget: ProjectBudgetState): Promise<WalkResult> {
    await this.deps.events.emitBudgetPaused({
      projectId,
      ceilingUsd: budget.ceilingUsd ?? 0,
      spentUsd: budget.spentUsd,
      period: budget.period,
      readyHeldBack: 0,
      ...(budget.failClosed !== undefined && { reason: budget.failClosed }),
    });
    return { projectId, status: "budget_paused", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }

  /**
   * Enqueue one planned spec. A NON-speculative spec (all deps merged) enqueues
   * against `default_branch` and emits dag.spec.enqueued. A SPECULATIVE spec first
   * builds its integration branch; on an ancestor-vs-ancestor conflict it is held
   * (returns undefined — the conflict pair surfaced for the P2b resolver); else it
   * enqueues against the integration branch and emits dag.spec.speculative.
   */
  private async enqueueOne(
    projectId: string,
    enqueue: PlannedEnqueue,
    threshold: SpeculationThreshold,
    inFlightBefore: number,
    ceiling: number,
    depsBySpec: Map<string, string[]>,
  ): Promise<{ runId: string } | undefined> {
    if (!enqueue.speculative) {
      const enqueued = await this.enqueueOrTolerate({ projectId, specId: enqueue.specId });
      if (enqueued === undefined) return undefined;
      await this.deps.events.emitSpecEnqueued({
        projectId,
        specId: enqueue.specId,
        runId: enqueued.runId,
        satisfiedDependsOn: depsBySpec.get(enqueue.specId) ?? [],
        inFlightBefore,
        concurrencyCeiling: ceiling,
      });
      return { runId: enqueued.runId };
    }

    const integration = await this.deps.integrator.buildIntegration({
      projectId,
      dependentSpecId: enqueue.specId,
      unmergedAncestorSpecIds: enqueue.unmergedAncestors,
    });
    if (integration.outcome === "conflict") {
      // The conflict is BETWEEN two ancestors — surfaced early on the integration
      // branch (§2c), where the P2b intent-preserving resolver runs against the
      // integration branch (not against the innocent dependent). The integrator
      // returns the conflicting pair; the dependent is HELD this tick (it cannot
      // base on a broken integration). The walker re-walks once the pair
      // reconciles/merges (the next merge.completed notification). Logged (not
      // silently dropped) per the §2c "no silent caps / no silent drops" rule.
      console.warn(
        `[dag-walker] held speculative ${enqueue.specId}: ancestors ${integration.conflictBetween?.specId} and ${integration.conflictBetween?.otherSpecId} conflict on ${integration.integrationBranch} (routes to the intent-preserving resolver): ${integration.message}`,
      );
      return undefined;
    }

    const enqueued = await this.enqueueOrTolerate({
      projectId,
      specId: enqueue.specId,
      speculativeBase: integration.integrationBranch,
      // P2c-2: record the per-ancestor head SHA the run integrated against (the
      // change-percolation divergence key); a later ancestor advance is detectable.
      integratedAncestorShas: integration.ancestorHeadShas,
    });
    if (enqueued === undefined) return undefined;
    await this.deps.events.emitSpecSpeculative({
      projectId,
      specId: enqueue.specId,
      runId: enqueued.runId,
      unmergedAncestors: enqueue.unmergedAncestors,
      threshold,
      integrationBranch: integration.integrationBranch,
    });
    return { runId: enqueued.runId };
  }

  /**
   * Enqueue a spec run, TOLERATING the two benign, EXPECTED per-spec enqueue
   * conditions. Either is a benign skip (return `undefined` — the caller emits no
   * enqueued event, logged at most at debug); the tick continues enqueuing the
   * OTHER ready specs and never aborts. EVERY OTHER error propagates unchanged — a
   * genuine failure (a 500 / unexpected fault) still surfaces loudly (no silent
   * fallback). Behavior is IDENTICAL whether the enqueuer ran in-process (it throws
   * the typed error directly) or through the control plane (the client reconstructs
   * the SAME typed error from the endpoint's typed 409).
   *
   *   1. SpecNotRunnableError — a concurrent walker tick already claimed this spec
   *      (its pending→active claim, the idempotency boundary, won). The spec is
   *      already in flight; nothing to do this tick.
   *   2. SpecDependenciesBlockedError — the spec's dependencies are not yet `done`
   *      at enqueue time (the planner saw them merged via the lifecycle projection,
   *      but the `specs.status='done'` write was not yet visible to the enqueue tx).
   *      The spec simply is not ready yet; a later tick enqueues it once the
   *      dependency lands as done. Tolerating it keeps this tick from aborting and
   *      starving the OTHER ready specs.
   */
  private async enqueueOrTolerate(input: {
    projectId: string;
    specId: string;
    speculativeBase?: string;
    integratedAncestorShas?: Record<string, string>;
  }): Promise<{ runId: string } | undefined> {
    try {
      return await this.deps.enqueuer.enqueueSpecRun(input);
    } catch (error) {
      if (error instanceof SpecNotRunnableError) {
        console.debug(
          `[dag-walker] skipped ${input.specId}: already claimed by a concurrent tick (status ${error.status}) — benign`,
        );
        return undefined;
      }
      if (error instanceof SpecDependenciesBlockedError) {
        console.debug(
          `[dag-walker] skipped ${input.specId}: dependencies not yet done (${error.blockedSpecIds.join(", ")}) — benign, a later tick will enqueue it`,
        );
        return undefined;
      }
      throw error;
    }
  }

  private async emitHeld(projectId: string, held: SpecReadiness[]): Promise<void> {
    for (const h of held) {
      await this.deps.events.emitSpeculationHeld({
        projectId,
        specId: h.specId,
        unmergedAncestors: h.unmergedAncestors,
        depth: h.depth,
        depthCap: h.depthCap,
      });
    }
  }
}

/**
 * Resolve a project's speculation config (threshold + depth cap) from its
 * versioned project config — the §2c knobs, never an env var. A project with no
 * resolvable config row (or an unparseable blob) falls back to the schema defaults
 * (moderate / depth 2), which is the same default a fresh project carries.
 */
export function buildSpeculationConfigResolver(pool: pg.Pool): SpeculationConfigResolver {
  return async (projectId: string): Promise<SpeculationConfig> => {
    const config = await runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
        projectId,
      ]);
      return result.rows[0]?.config;
    });
    try {
      const parsed = migrateProjectConfig(config);
      return { threshold: parsed.speculationThreshold, depthCap: parsed.speculativeIntegrationDepth };
    } catch {
      return { threshold: DEFAULT_SPECULATION_THRESHOLD, depthCap: DEFAULT_SPECULATIVE_INTEGRATION_DEPTH };
    }
  };
}

export interface BuildDagWalkerDeps {
  /** The speculative integrator (builds the dynamic-base integration branch). */
  integrator: SpeculativeIntegrator;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present,
   * the enqueuer routes its run-CREATION through the control plane and the event
   * emitter routes its dag.* events through it — instead of the de-privileged
   * direct-pool writes (migrations 0031/0035). Absent ⇒ the direct-pool writes,
   * byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
}

/**
 * Build the production DagWalker from a runtime pool + the speculative integrator
 * — the single construction site the worker boot + subscriber use. Wires the pg
 * read model + lifecycle projection, the createQueuedRunFromSpec enqueuer, the pg
 * event emitter, and the per-project speculation-config resolver; the concurrency
 * ceiling defaults to the config surface (resolveWorkerConcurrency). When a
 * `runStateWriter` is supplied (plane-split remote-writes), the enqueuer + event
 * emitter route their tenant writes through the control plane instead.
 */
export function buildDagWalker(pool: pg.Pool, deps: BuildDagWalkerDeps): DagWalker {
  return new EventEmittingDagWalker({
    readModel: new PgDagReadModel(pool),
    lifecycleReadModel: new PgDagLifecycleReadModel(pool),
    enqueuer: new SpecRunDagEnqueuer(pool, deps.runStateWriter),
    events: new PgDagEventEmitter(pool, deps.runStateWriter),
    integrator: deps.integrator,
    speculationConfig: buildSpeculationConfigResolver(pool),
    budgetGate: new PgBudgetGate(pool),
  });
}

/** Discover every project id that has a DAG to walk (system-scoped, cross-org). */
export async function listWalkableProjectIds(pool: pg.Pool): Promise<string[]> {
  const system = getSystemPool() ?? pool;
  return runWithSystemScope(system, async (client) => {
    const result = await client.query<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM specs WHERE project_id IS NOT NULL ORDER BY project_id",
    );
    return result.rows.map((row) => row.project_id);
  });
}

// Re-exported so existing import sites (and the conformance/tests) keep pulling
// the pg seam wirings + classifier from `walker.ts` after the §2c split.
export { classifySpecStatus, PgDagReadModel, SpecRunDagEnqueuer, PgDagEventEmitter } from "./walkerPg.js";
export type { DagEventEmitter };
