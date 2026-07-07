// The pg-backed DagWalker seam wirings (autonomy-engine.md §1a, §2c), split out of
// `walker.ts` to keep each file under the 500-line cap. This module carries the
// three production wirings of the contract seams the EventEmittingDagWalker
// composes:
//   - PgDagReadModel: the org-scoped DAG snapshot read (DAG state is the source of
//     truth; read fresh each tick, RLS-scoped to the project's org).
//   - SpecRunDagEnqueuer: createQueuedRunFromSpec under a platform-admin actor carrying
//     the project's org (the atomic pending→active claim is the idempotency boundary). A
//     speculative start threads the ancestor stack (the jj-local base) + skips the
//     done-only dependency gate.
//   - PgDagAncestorStackResolver: resolves a dependent's ordered unmerged-ancestor stack
//     (org-scoped/RLS) — the real PR-head branches the dependent jj-assembles its base from.
//   - PgDagEventEmitter: writes the dag.* events (enqueued / speculative /
//     speculation_held / drained / budget.paused / budget.milestone /
//     concurrency.saturated / config.corrupt) through the single org-scoped
//     event-writer seam.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { BudgetPeriod, SpeculationThreshold } from "../config/index.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type {
  DagEnqueuer,
  DagReadModel,
  DagSnapshot,
  DagSpecNode,
  DagSpecPhase,
  DagTickPlan,
} from "../contracts/dagWalker.js";
import type { DagConfigCorruptPayload } from "../events/schemas/dag.js";
import { SpecPriority } from "../state/spec.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";
import type { AncestorStack } from "./ancestorStack.js";
// Re-export the ancestor-stack resolver seam + wiring (split into `ancestorStackResolverPg.ts`
// for the line cap) so existing `./walkerPg.js` import sites keep importing them unchanged.
export { type DagAncestorStackResolver, PgDagAncestorStackResolver } from "./ancestorStackResolverPg.js";

/**
 * Map a persisted spec status (the SINGLE canonical `open/in_flight/review/merged/
 * halted/cancelled/needs_attention` vocabulary) onto the walker's three scheduling
 * buckets. A spec the walker may START (`open`) maps to the `pending` bucket; one
 * already OCCUPYING A SLOT (`in_flight`/`review`) maps to `in_flight`; the
 * SATISFIED-DEPENDENCY terminal (`merged`) maps to `done` (§1a: "all deps merged").
 * A terminally-halted/cancelled/needs_attention spec is neither a candidate nor a
 * satisfied dependency: it blocks any dependent (correct — the dependent cannot run
 * on a halted ancestor until an operator routes past it). There is no second status
 * vocabulary to normalize: every writer speaks this one.
 */
export function classifySpecStatus(status: string): DagSpecPhase {
  switch (status) {
    case "open":
      return "pending";
    case "in_flight":
    case "review":
      return "in_flight";
    case "merged":
      return "done";
    case "halted":
    case "cancelled":
    // NEVER-STRAND escalation: a spec the strand-reconciler gave up re-enqueuing
    // (bounded escalation) is terminal — it FREES its slot and blocks ONLY its
    // dependents (never the whole DAG), exactly like a halted/cancelled spec.
    // falls through
    case "needs_attention":
      return "terminal_blocked";
    default:
      // An unknown status is treated as occupying a slot, never as a satisfied
      // dependency — the walker must never run a dependent on an unrecognized
      // ancestor state, and must never re-enqueue an unrecognized spec.
      return "in_flight";
  }
}

interface SpecDagRow {
  spec_id: string;
  status: string;
  depends_on: unknown;
  priority: unknown;
  rn: string | number;
  // Codex H3 #9 — the four triage-routing PROVENANCE columns (Claude RA2,
  // migration 0025). All NULLABLE: a non-routed spec has null across the four; a
  // routed spec has parent_spec_id set (the sentinel that promotes the trail
  // onto `DagSpecNode.triageProvenance`).
  parent_spec_id: string | null;
  source_finding_ids: unknown;
  origin_triage_task_id: string | null;
  origin_run_id: string | null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Codex H3 #9 — hydrate the walker-snapshot triage-routing provenance from a raw
 * spec row. Returns undefined when parent_spec_id is null (the "not routed"
 * sentinel), else the {@link DagSpecTriageProvenance} trail with defensive
 * fallbacks for legacy rows: a null `source_finding_ids` degrades to `[]` and a
 * null origin_* field degrades to "" (the parent trail still identifies the
 * routed spec). See {@link SpecTriageProvenance} in workflow/projectSpec.ts.
 */
function hydrateTriageProvenance(row: SpecDagRow): DagSpecNode["triageProvenance"] {
  const parentSpecId = row.parent_spec_id;
  if (parentSpecId === null || parentSpecId === undefined || parentSpecId === "") return undefined;
  return {
    parentSpecId,
    sourceFindingIds: asStringArray(row.source_finding_ids),
    originTriageTaskId: row.origin_triage_task_id ?? "",
    originRunId: row.origin_run_id ?? "",
  };
}

/**
 * The pg-backed DAG read model. Resolves the project's org (system-scoped, the
 * same bootstrap the worker + benchmark use to discover an org before any tenant
 * work), then reads the project's specs UNDER THAT ORG SCOPE (RLS). A read off
 * the wrong scope sees zero rows — so the snapshot is always exactly the project's
 * own DAG. The `priority` column is the primary ordering key (the pure planner's
 * `orderReadySet` sorts P0→tbd first); the `orderKey` (creation order) is the
 * deterministic tiebreak within a priority.
 *
 * Codex critic #10 — DETERMINISTIC ORDERING: the `orderKey` is a `row_number()`
 * over `(created_at, spec_id)`, the stable LOGICAL creation order. It is
 * emphatically NOT `ctid` (the physical tuple pointer): a VACUUM, table rewrite,
 * or UPDATE can move a row's `ctid` without touching the DAG, which would flip the
 * ready-set tiebreak between ticks on byte-identical input. `created_at` is a
 * `NOT NULL DEFAULT now()` column stamped at insert; `spec_id` is the PK — both
 * are immutable for the row's lifetime, so the tiebreak is stable across VACUUMs.
 * The composite `specs_project_created` index (see db/src/schemaCore.ts) supports
 * this per-project ordered read.
 */
export class PgDagReadModel implements DagReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async loadSnapshot(projectId: string): Promise<DagSnapshot> {
    const project = await this.resolveProject(projectId);
    if (project.orgId === null) {
      // No resolvable org ⇒ no DAG the walker may schedule (RLS would deny every
      // read anyway). An empty snapshot drains cleanly rather than throwing.
      return { projectId, nodes: [], archived: false };
    }
    if (project.archived) {
      // Archived ⇒ dormant. Skip the spec read entirely; the walker short-circuits
      // on `archived` and enqueues nothing.
      return { projectId, nodes: [], archived: true };
    }
    const orgId = project.orgId;
    const nodes = await runWithOrgScope(this.pool, orgId, async (client) => {
      // Codex H3 #9 — SELECT the four triage-routing PROVENANCE columns so the
      // DAG snapshot carries the routing origin for every routed spec node.
      // Absent from the previous SELECT, the DAG view was blind to the routing
      // trail even though the columns had persisted since PR #755.
      const result = await client.query<SpecDagRow>(
        `SELECT spec_id, status, depends_on, priority,
                parent_spec_id, source_finding_ids, origin_triage_task_id, origin_run_id,
                row_number() OVER (ORDER BY created_at ASC, spec_id ASC) AS rn
           FROM specs
          WHERE project_id = $1`,
        [projectId],
      );
      return result.rows.map((row): DagSpecNode => {
        const triageProvenance = hydrateTriageProvenance(row);
        return {
          specId: row.spec_id,
          phase: classifySpecStatus(row.status),
          dependsOn: asStringArray(row.depends_on),
          // The DB CHECK guarantees a valid value; parse defends the read seam.
          priority: SpecPriority.parse(row.priority),
          orderKey: Number(row.rn),
          ...(triageProvenance !== undefined && { triageProvenance }),
        };
      });
    });
    return { projectId, nodes, archived: false };
  }

  private async resolveProject(projectId: string): Promise<{ orgId: string | null; archived: boolean }> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null; lifecycle: string }>(
        "SELECT org_id, lifecycle FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      return { orgId: row?.org_id ?? null, archived: row?.lifecycle === "archived" };
    });
  }
}

/**
 * The production enqueuer: create a queued run for a ready spec via the EXISTING
 * createQueuedRunFromSpec path. It runs as a platform-admin actor carrying the
 * project's org so the run/task/event/job writes are RLS-scoped to the tenant
 * (exactly as the BenchmarkRunner's system-actor provisioning does). The atomic
 * pending→active claim INSIDE createQueuedRunFromSpec is the idempotency boundary:
 * a spec already past `pending` raises SpecNotRunnableError, so a concurrent tick
 * can never double-enqueue it.
 */
export class SpecRunDagEnqueuer implements DagEnqueuer {
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, the
   *   run-CREATION transaction routes through the control plane (the de-privileged
   *   data plane can no longer write `runs`/`specs`/`tasks`/`events` directly);
   *   absent, `createQueuedRunFromSpec` runs in-process — byte-identical to today.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async enqueueSpecRun(input: {
    projectId: string;
    specId: string;
    ancestorStack?: AncestorStack;
  }): Promise<{ runId: string }> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [input.projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      throw new Error(`cannot enqueue spec ${input.specId}: project ${input.projectId} has no resolvable org`);
    }
    const actor: ActorContext = {
      userId: "dag-walker",
      orgId,
      projectId: input.projectId,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
    const createInput = {
      specId: input.specId,
      trigger: "dag_walker",
      // A speculative start (a present `ancestor_stack`) skips the done-only dependency
      // gate and records the ordered unmerged-ancestor stack as the run's jj-local base
      // source. NO synthesized host integration ref is written.
      ...(input.ancestorStack !== undefined && {
        speculative: {
          ancestorStack: input.ancestorStack,
        },
      }),
    };
    // Plane-split: route the full multi-table run-CREATE transaction through the
    // control plane when a writer is wired; else create it in-process on the pool.
    // Both run the SAME `createQueuedRunFromSpec` under the actor's org scope.
    const run =
      this.runStateWriter === undefined
        ? await createQueuedRunFromSpec(this.pool, createInput, actor)
        : await this.runStateWriter.createQueuedRun({ input: createInput, actor });
    return { runId: run.runId };
  }
}

/** The `dag.config.corrupt` emit input: the project + the event payload. */
export type ConfigCorruptInput = { projectId: string } & DagConfigCorruptPayload;

/** What the walker needs to emit a dag.* event (org-scoped, through eventStore). */
interface DagEventEmitter {
  emitSpecEnqueued(input: {
    projectId: string;
    specId: string;
    runId: string;
    satisfiedDependsOn: string[];
    inFlightBefore: number;
    concurrencyCeiling: number;
  }): Promise<void>;
  emitSpecSpeculative(input: {
    projectId: string;
    specId: string;
    runId: string;
    unmergedAncestors: string[];
    threshold: SpeculationThreshold;
  }): Promise<void>;
  emitSpeculationHeld(input: {
    projectId: string;
    specId: string;
    unmergedAncestors: string[];
    depth: number;
    depthCap: number;
  }): Promise<void>;
  /**
   * The CHEAP ancestor-not-ready DEFER (apex v35 hot-loop fix): a speculative dependent was NOT
   * enqueued because an unmerged ancestor has not published its PR head (cheap pre-check) — no
   * runner allocated. `runId: ""` (no run created); spaced by the per-spec backoff so a storm
   * fires this a handful of times. Same `dag.spec.ancestor_not_ready` the assembly emits.
   */
  emitAncestorNotReady(input: {
    projectId: string;
    specId: string;
    ancestorSpecId: string;
    ancestorPhase: "pending" | "in_flight";
  }): Promise<void>;
  emitDrained(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
  /**
   * The dollar-budget pause: cumulative spend reached the configured ceiling, OR a
   * BUDGET-SAFETY (C1b/M5) fail-closed safety pause (`reason` set).
   */
  emitBudgetPaused(input: {
    projectId: string;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
    readyHeldBack: number;
    reason?: "unpriced_spend" | "unparseable_config" | "unresolvable_project_org";
  }): Promise<void>;
  /**
   * A budget FRACTION milestone (50% / 80% of the ceiling crossed before the terminal
   * pause). IDEMPOTENT per band per budget window: appends ONLY if no `dag.budget.milestone`
   * for the same band exists in the current calendar window (so re-walks never re-ping).
   * Returns true when appended, false when deduped — the walker logs the dedup, never silent.
   */
  emitBudgetMilestone(input: {
    projectId: string;
    band: 50 | 80;
    ceilingUsd: number;
    spentUsd: number;
    period: BudgetPeriod;
  }): Promise<boolean>;
  /** The concurrency-saturation hold: ready specs held back because no slot is free. */
  emitConcurrencySaturated(input: { projectId: string; plan: DagTickPlan }): Promise<void>;
  /** no_silent_fallbacks (LOUD-DEFAULT): a corrupt persisted project config the walker
   * read while resolving a NON-merge eagerness knob; it proceeds at the SAFE default but
   * surfaces the corruption here (and logs) rather than swallowing it. */
  emitConfigCorrupt(input: ConfigCorruptInput): Promise<void>;
}

// `PgDagEventEmitter` + `budgetMilestoneWindowClause` moved to `dagEventEmitterPg.ts` (line
// cap); re-exported so existing import sites keep importing it from `./walkerPg.js`.
export { PgDagEventEmitter } from "./dagEventEmitterPg.js";

export type { DagEventEmitter };
