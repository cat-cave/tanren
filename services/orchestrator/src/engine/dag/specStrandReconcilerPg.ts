// The pg-backed NEVER-STRAND reconciler seam wirings, split from
// `specStrandReconciler.ts` to keep each file under the 500-line cap. Three
// production wirings of the `SpecStrandReconciler` contract seams the coordinator
// composes:
//   - PgSpecStrandReadModel: the org-scoped READ — every spec OCCUPYING A SLOT
//     (its persisted status classifies `in_flight`) together with its runs (status +
//     decoded percolation marker + whether the marker's re-exec is itself LIVE), and
//     a per-spec active-merge-queue flag. Plus the per-spec count of prior
//     `dag.spec.unstranded` events (the bounded-escalation key). DAG state is the
//     source of truth: read fresh each pass.
//   - PgSpecStrandWriter: the flip/escalate/clear writes — `active → pending`
//     (re-enqueue) or `active → needs_attention` (escalate), both
//     `notFromStatuses`-guarded, + clearing an orphaned percolation marker. Routed
//     through the control-plane writer when wired (plane-split), else direct.
//   - PgSpecStrandEventEmitter: writes the two dag.spec.* strand events through the
//     single org-scoped event-writer seam (mirrors PgDagEventEmitter).

import { getSystemPool, runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  SpecStrandEventEmitter,
  SpecStrandReadModel,
  SpecStrandSnapshot,
  SpecStrandWriter,
  StrandReason,
} from "../contracts/specStrandReconciler.js";
import { classifySpecStatus } from "./walkerPg.js";
import { decodePercolationPending, resolveProjectOrg, resolveProjectOrgLifecycle } from "./percolationWrites.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { applyReconcileStrandedSpec } from "../worker/runStateLifecycleSql.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import { SpecStrandReconciler } from "./specStrandReconciler.js";

interface StrandSpecRow {
  spec_id: string;
  status: string;
}

interface StrandRunRow {
  run_id: string;
  spec_id: string;
  status: string;
  percolation_pending: unknown;
  /** Whether the run the marker points at (`reexecRunId`) is still queued/running. */
  reexec_live: boolean | null;
  /** Whether THIS run has a non-terminal merge_queue entry. */
  in_merge_queue: boolean | null;
}

/**
 * The pg-backed strand read model. Resolves the project's org (system-scoped
 * bootstrap, the same hop the walker/percolation use), then reads the project's
 * slot-occupying specs + their runs UNDER THAT ORG SCOPE (RLS). A read off the wrong
 * scope sees zero rows — so the snapshot is always exactly the project's own state.
 */
export class PgSpecStrandReadModel implements SpecStrandReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async loadStrandCandidates(projectId: string): Promise<SpecStrandSnapshot[]> {
    const { orgId, archived } = await resolveProjectOrgLifecycle(this.pool, projectId);
    // No resolvable org ⇒ nothing to reconcile. Archived ⇒ dormant: never re-enqueue
    // an archived project's stranded specs (it stays paused until unarchived).
    if (orgId === null || archived) return [];
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const specRows = await client.query<StrandSpecRow>("SELECT spec_id, status FROM specs WHERE project_id = $1", [
        projectId,
      ]);
      // Only specs that OCCUPY A SLOT are candidates (condition 1). Resolving the
      // classifier here keeps the predicate's "in_flight" notion in ONE place.
      const slotSpecs = specRows.rows.filter((s) => classifySpecStatus(s.status) === "in_flight");
      if (slotSpecs.length === 0) return [];
      const specIds = slotSpecs.map((s) => s.spec_id);

      // Per run: its status, its decoded percolation marker, whether the marker's
      // re-exec run is itself LIVE (a LEFT JOIN to the re-exec run's status), and
      // whether THIS run is in a non-terminal merge_queue entry. All org-scoped.
      const runRows = await client.query<StrandRunRow>(
        `SELECT r.run_id,
                r.spec_id,
                r.status,
                r.percolation_pending,
                CASE
                  WHEN r.percolation_pending IS NULL THEN NULL
                  ELSE EXISTS (
                    SELECT 1 FROM runs rx
                     WHERE rx.run_id = (r.percolation_pending->>'reexecRunId')
                       AND rx.status IN ('queued','running')
                  )
                END AS reexec_live,
                EXISTS (
                  SELECT 1 FROM merge_queue mq
                   WHERE mq.run_id = r.run_id AND mq.status IN ('queued','merging')
                ) AS in_merge_queue
           FROM runs r
          WHERE r.spec_id = ANY($1::text[])`,
        [specIds],
      );

      const runsBySpec = new Map<string, StrandRunRow[]>();
      for (const row of runRows.rows) {
        const list = runsBySpec.get(row.spec_id) ?? [];
        list.push(row);
        runsBySpec.set(row.spec_id, list);
      }

      return slotSpecs.map((spec): SpecStrandSnapshot => {
        const runs = runsBySpec.get(spec.spec_id) ?? [];
        return {
          specId: spec.spec_id,
          status: spec.status,
          hasActiveMergeQueueEntry: runs.some((r) => r.in_merge_queue === true),
          runs: runs.map((r) => {
            const marker = decodePercolationPending(r.percolation_pending);
            return {
              runId: r.run_id,
              status: r.status,
              ...(marker !== undefined && {
                percolationPending: {
                  reexecRunId: marker.reexecRunId,
                  reexecRunLive: r.reexec_live === true,
                },
              }),
            };
          }),
        };
      });
    });
  }

  async countPriorUnstrands(input: { projectId: string; specId: string }): Promise<number> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) return 0;
    // Read on the BYPASSRLS system role (`getSystemPool() ?? this.pool`): this
    // SELECTs `events`, which the de-privileged data-plane role cannot read (0031
    // REVOKE ALL ON TABLE events) — so on the dataplane pool the COUNT throws
    // `permission denied for table events` (42501). The org scope is still applied
    // on top (`runWithOrgScope` sets app.current_org_id), so the read stays
    // org-scoped — only the ROLE changes to one that can SELECT events. This mirrors
    // `PgDagLifecycleReadModel.loadLifecycle`. (The specs/runs/merge_queue reads in
    // `loadStrandCandidates` keep their grants under the dataplane role — 0035 only
    // revoked WRITES there — so they stay on `this.pool`.)
    const readPool = getSystemPool() ?? this.pool;
    return runWithOrgScope(readPool, orgId, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM events
          WHERE spec_id = $1 AND event_type = 'dag.spec.unstranded'`,
        [input.specId],
      );
      return Number(result.rows[0]?.count ?? "0");
    });
  }
}

/**
 * The pg-backed strand writer. The two status flips are `notFromStatuses`-guarded
 * (`['done','merged']`) so a just-landed merge is never clobbered — byte-identical to
 * the percolation reexecutor's reopen. Plane-split: route through the control-plane
 * writer when wired (the de-privileged data plane can no longer UPDATE specs/runs);
 * else direct on the org-scoped pool.
 */
export class PgSpecStrandWriter implements SpecStrandWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  async reEnqueueSpec(input: { projectId: string; specId: string }): Promise<{ flipped: boolean }> {
    return this.atomicFlip(input.projectId, input.specId, "pending");
  }

  async escalateSpec(input: { projectId: string; specId: string }): Promise<{ flipped: boolean }> {
    return this.atomicFlip(input.projectId, input.specId, "needs_attention");
  }

  /**
   * The ATOMIC strand-flip: a single guarded UPDATE that re-checks the FULL strand
   * invariant in the same statement (no TOCTOU window). A concurrent percolation
   * re-exec that reclaimed the spec / created a live run between the reconciler's read
   * and this flip yields ZERO rows → `{ flipped: false }` (a safe no-op). Plane-split:
   * route through the control-plane writer when wired; else run the shared applier
   * org-scoped directly.
   */
  private async atomicFlip(
    projectId: string,
    specId: string,
    status: "pending" | "needs_attention",
  ): Promise<{ flipped: boolean }> {
    const orgId = await resolveProjectOrg(this.pool, projectId);
    if (orgId === null) throw new Error(`project ${projectId} has no org for the strand-reconciler write`);
    if (this.runStateWriter !== undefined) {
      return this.runStateWriter.reconcileStrandedSpec({ specId, orgId, status });
    }
    return runWithOrgScope(this.pool, orgId, (client) => applyReconcileStrandedSpec(client, { specId, orgId, status }));
  }

  async clearOrphanedMarker(input: { projectId: string; runId: string }): Promise<void> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) throw new Error(`project ${input.projectId} has no org for the strand-reconciler write`);
    if (this.runStateWriter !== undefined) {
      await this.runStateWriter.clearRunPercolationPending({ runId: input.runId, orgId });
      return;
    }
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query("UPDATE runs SET percolation_pending = NULL WHERE run_id = $1", [input.runId]);
    });
  }
}

export interface PgSpecStrandEventEmitterDeps {
  pool: pg.Pool;
  /**
   * Plane-split (autonomy loops): when present, the dag.spec.* strand events append
   * through the control-plane writer (the de-privileged data plane can no longer
   * write `events` directly); absent, in-process via `PgEventStore`.
   */
  runStateWriter?: RunStateWriter;
}

/** The pg-backed dag.spec.unstranded / dag.spec.needs_attention emitter (org-scoped). */
export class PgSpecStrandEventEmitter implements SpecStrandEventEmitter {
  constructor(private readonly deps: PgSpecStrandEventEmitterDeps) {}

  private async withScopedStore(projectId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return;
    if (this.deps.runStateWriter !== undefined) {
      const writer = this.deps.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
    await runWithOrgScope(this.deps.pool, orgId, (client) => work(new PgEventStore(client)));
  }

  async emitUnstranded(input: {
    projectId: string;
    specId: string;
    reason: StrandReason;
    terminalRuns: Array<{ runId: string; status: string }>;
    attempt: number;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.unstranded",
        payload: {
          specId: input.specId,
          reason: input.reason,
          terminalRuns: input.terminalRuns,
          attempt: input.attempt,
        },
      }),
    );
  }

  async emitNeedsAttention(input: {
    projectId: string;
    specId: string;
    reason: StrandReason;
    terminalRuns: Array<{ runId: string; status: string }>;
    attempts: number;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.needs_attention",
        payload: {
          specId: input.specId,
          reason: input.reason,
          terminalRuns: input.terminalRuns,
          attempts: input.attempts,
        },
      }),
    );
  }
}

/** Assemble the production strand reconciler from a pool (+ optional plane-split writer). */
export interface BuildSpecStrandReconcilerDeps {
  pool: pg.Pool;
  runStateWriter?: RunStateWriter;
}

/** Assemble the production NEVER-STRAND reconciler (read model + writer + events). */
export function buildSpecStrandReconciler(deps: BuildSpecStrandReconcilerDeps): SpecStrandReconciler {
  return new SpecStrandReconciler({
    readModel: new PgSpecStrandReadModel(deps.pool),
    writer: new PgSpecStrandWriter(deps.pool, deps.runStateWriter),
    events: new PgSpecStrandEventEmitter({
      pool: deps.pool,
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    }),
  });
}
