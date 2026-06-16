// The PRODUCTION batch-gate-fail rework router (v35 — the batch-gate-fail-strand fix).
//
// THE BUG IT CLOSES: a spec authored work that passed its OWN per-iteration + pre-merge
// branch gates, opened a PR, got auto-approved + merge-queued. The native merge queue's
// BATCH check (the prospective MERGED/integrated tree gate) then FAILED — a failure that
// manifests ONLY in the integrated tree (e.g. a config file not covered by the integrated
// tsconfig). Bisect blamed the culprit and the coordinator dequeued it with
// `reason: "conflict"` — but a `conflict`-reason dequeue has NO re-execution consumer (the
// recovery SQL only re-queues `blocked`), so the spec sat `in_flight` forever and the
// build could never converge (downstream specs cascade-block on it).
//
// THE FIX: a GATE-fail culprit (distinct from a CONFLICT culprit, which still routes to
// the conflict resolver / replan) is routed back to the WRITER for REWORK, carrying the
// batch gate's failing tier/step/output as steering so the writer fixes the RIGHT thing
// (no_silent_fallback — never rework blind). This REUSES the never-discard
// re-plan-with-steering mechanism (`buildReplanEnqueuer`): re-open the spec to `open`,
// append the gate error as steering, enqueue a fresh re-author run. After the rework
// produces a new head, the spec re-queues for merge normally.
//
// BOUNDED (never a hot-loop): a spec re-worked `MAX_BATCH_GATE_REWORKS` times for the SAME
// integrated-gate failure that STILL fails is genuinely stuck — instead of re-working
// again it ESCALATES as a LOUD `needs_attention` (the `persistent_failure` finalize path),
// never a silent strand. The bound key is the spec's prior `merge.batch.gate_rework_routed`
// (disposition `reworked`) count — a dedicated budget, SEPARATE from the conflict-replan
// `MAX_BASE_SHIFT_REPLANS` budget (a gate-fail and a conflict are different failure modes).

import { getSystemPool, runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { ReplanEnqueuer } from "../workflow/reviewMerge/conflictResolver/replanRouter.js";
import { buildReplanEnqueuer } from "../workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import { SpecNotRunnableError } from "../workflow/projectSpecErrors.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("batch-gate-rework");

/**
 * The bounded batch-gate-rework budget: a spec whose integrated-tree GATE failure cannot
 * be fixed by re-authoring is re-worked AT MOST this many times. Once the spec's prior
 * `merge.batch.gate_rework_routed` (disposition `reworked`) count REACHES this (`>=`), the
 * next routing ESCALATES to `needs_attention` instead of enqueuing another rework. Mirrors
 * the conflict-replan `MAX_BASE_SHIFT_REPLANS` convention (same bound, different budget
 * key) so BOTH self-heal routes are bounded the same way.
 */
export const MAX_BATCH_GATE_REWORKS = 3;

export interface BatchGateReworkRouterDeps {
  pool: pg.Pool;
  runStateWriter?: RunStateWriter;
  /** Enqueues the writer-rework run (re-open + steering + run-create). Production wires `buildReplanEnqueuer`. */
  enqueuer?: ReplanEnqueuer;
  /** Counts the spec's prior gate-reworks (the bounded budget). Production reads the events table. */
  priorReworks?: (input: { specId: string; orgId: string }) => Promise<number>;
  /**
   * TEST SEAM: resolve the project's org. Production OMITS it → the system-scoped
   * `resolveProjectOrg`. A no-DB unit run injects it so the router never touches the
   * cross-org system pool machinery.
   */
  resolveOrg?: (projectId: string) => Promise<string | null>;
  /**
   * TEST SEAM: append a durable event under the resolved org. Production OMITS it → the
   * plane-split PgEventStore / RunStateWriter under the org scope. A no-DB unit run
   * injects a recording store so event assertions need no DB or scope globals.
   */
  appendEvent?: (orgId: string, event: Parameters<EventStore["append"]>[0]) => Promise<void>;
}

/**
 * The production batch-gate-rework router. Resolves the project org (the coordinator wakes
 * with no ambient scope), reads the bounded budget, and either enqueues a fresh
 * writer-rework run (re-author on the gate error as steering) or escalates to
 * `needs_attention` past the budget — emitting the observable `merge.batch.gate_rework_routed`
 * either way (never a silent strand).
 */
export class PgBatchGateReworkRouter implements BatchGateReworkRouter {
  private readonly enqueuer: ReplanEnqueuer;
  private readonly priorReworks: (input: { specId: string; orgId: string }) => Promise<number>;

  private readonly resolveOrg: (projectId: string) => Promise<string | null>;

  constructor(private readonly deps: BatchGateReworkRouterDeps) {
    this.enqueuer = deps.enqueuer ?? buildReplanEnqueuer(deps.pool, deps.runStateWriter);
    this.priorReworks = deps.priorReworks ?? ((input) => countPriorGateReworks(deps.pool, input));
    this.resolveOrg = deps.resolveOrg ?? ((projectId) => resolveProjectOrg(deps.pool, projectId));
  }

  async routeGateFailToRework(input: {
    projectId: string;
    culprit: MergeQueueEntry;
    gateError: string;
  }): Promise<"reworked" | "escalated"> {
    const orgId = await this.resolveOrg(input.projectId);
    // A required-missing org is a LOUD hard failure (no_silent_fallback): without it the
    // spec cannot be re-worked OR escalated, so a gate-fail would silently strand — exactly
    // the bricking this router exists to prevent.
    if (orgId === null) {
      throw new Error(
        `cannot route gate-fail rework for spec ${input.culprit.specId}: project ${input.projectId} has no org`,
      );
    }

    const priorReworks = await this.priorReworks({ specId: input.culprit.specId, orgId });
    // BOUNDED: a spec re-worked the budget number of times that STILL fails the integrated
    // gate is genuinely stuck — escalate LOUD instead of re-working forever.
    if (priorReworks >= MAX_BATCH_GATE_REWORKS) {
      await this.escalate(orgId, input, priorReworks);
      return "escalated";
    }

    const steeringNote = buildGateReworkSteering(input.gateError, priorReworks);
    try {
      // The never-discard re-author: re-open the spec to `open` + append the gate error as
      // steering + enqueue a fresh writer-rework run (the same mechanism the conflict-replan
      // route uses). The new run re-authors to fix the integration-only failure, then
      // re-queues for merge normally.
      const run = await this.enqueuer.enqueue({
        specId: input.culprit.specId,
        orgId,
        projectId: input.projectId,
        steeringNote,
        reopenStatus: "open",
      });
      await this.recordReworked(orgId, input, priorReworks, steeringNote, run.replanRunId, run.plannerTaskId);
      return "reworked";
    } catch (error) {
      // BENIGN RACE: a concurrent tick already claimed the re-opened spec — a run IS being
      // driven, so this is not a strand. Record the routing observably (no new run id) + treat
      // as re-worked.
      if (error instanceof SpecNotRunnableError) {
        log.warn(
          "gate-fail rework found the spec already claimed by a concurrent tick — it is being re-driven; skipping the duplicate enqueue",
          { specId: input.culprit.specId },
          error,
        );
        await this.recordReworked(orgId, input, priorReworks, steeringNote);
        return "reworked";
      }
      // GENUINE FAILURE: the rework run could not be created AND no concurrent tick owns it.
      // A routed rework that cannot RUN is not a recoverable re-author; it is a genuine
      // failure a human must see — escalate LOUD (never swallow into a silent strand).
      log.error(
        "gate-fail rework FAILED to enqueue a run for the culprit spec — escalating (never a silent strand)",
        { specId: input.culprit.specId },
        error,
      );
      await this.escalateEnqueueFailure(orgId, input, error);
      return "escalated";
    }
  }

  /** Record the observable `merge.batch.gate_rework_routed` (disposition `reworked`) + the run-enqueue lineage. */
  private async recordReworked(
    orgId: string,
    input: { projectId: string; culprit: MergeQueueEntry; gateError: string },
    priorReworks: number,
    steeringNote: string,
    replanRunId?: string,
    plannerTaskId?: string,
  ): Promise<void> {
    await this.withScopedStore(orgId, async (store) => {
      await store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "merge.batch.gate_rework_routed",
        payload: {
          integration: "native_queue",
          specId: input.culprit.specId,
          runId: input.culprit.runId,
          prNumber: input.culprit.prNumber,
          disposition: "reworked",
          gateError: input.gateError,
          priorReworks,
        },
      });
      // The OBSERVABLE run-enqueue lineage (only when a NEW run was created — the benign
      // already-claimed race did not create one; a concurrent tick emitted its own run.queued).
      if (replanRunId !== undefined && plannerTaskId !== undefined) {
        await store.append({
          runId: input.culprit.runId,
          specId: input.culprit.specId,
          projectId: input.projectId,
          eventType: "recovery.replan_queued",
          payload: {
            runId: input.culprit.runId,
            specId: input.culprit.specId,
            action: "replan_with_steering",
            steeringNote,
            replanRunId,
            plannerTaskId,
          },
        });
      }
    });
  }

  /** ESCALATE: the bounded rework budget is exhausted — park `needs_attention` (loud, frees the slot). */
  private async escalate(
    orgId: string,
    input: { projectId: string; culprit: MergeQueueEntry; gateError: string },
    priorReworks: number,
  ): Promise<void> {
    await this.parkSpec(orgId, input.culprit.specId);
    await this.withScopedStore(orgId, async (store) => {
      await store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "merge.batch.gate_rework_routed",
        payload: {
          integration: "native_queue",
          specId: input.culprit.specId,
          runId: input.culprit.runId,
          prNumber: input.culprit.prNumber,
          disposition: "escalated",
          gateError: input.gateError,
          priorReworks,
        },
      });
      await store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: input.culprit.specId,
          reason: "persistent_failure",
          terminalRuns: [{ runId: input.culprit.runId, status: "halted" }],
          attempts: priorReworks,
          message:
            `the autonomous self-heal re-worked this spec ${priorReworks} times to fix an integrated-tree ` +
            `gate failure and it STILL fails the batch gate — a human must intervene. Latest gate error: ${input.gateError}`,
        },
      });
    });
  }

  /** ESCALATE an enqueue failure: a rework whose run could not be created is genuinely stuck. */
  private async escalateEnqueueFailure(
    orgId: string,
    input: { projectId: string; culprit: MergeQueueEntry; gateError: string },
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    await this.parkSpec(orgId, input.culprit.specId);
    await this.withScopedStore(orgId, async (store) => {
      await store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "merge.batch.gate_rework_routed",
        payload: {
          integration: "native_queue",
          specId: input.culprit.specId,
          runId: input.culprit.runId,
          prNumber: input.culprit.prNumber,
          disposition: "escalated",
          gateError: input.gateError,
          priorReworks: 0,
        },
      });
      await store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        eventType: "dag.spec.needs_attention",
        payload: {
          source: "strand",
          specId: input.culprit.specId,
          reason: "persistent_failure",
          terminalRuns: [{ runId: input.culprit.runId, status: "halted" }],
          attempts: 0,
          message:
            `the autonomous self-heal routed this spec back to the writer to fix an integrated-tree gate ` +
            `failure but could NOT enqueue the rework run (${detail}) — a human must intervene. Gate error: ${input.gateError}`,
        },
      });
    });
  }

  /** Guarded, plane-split-safe spec park to `needs_attention` (mirrors PgSpecEscalator). */
  private async parkSpec(orgId: string, specId: string): Promise<void> {
    if (this.deps.runStateWriter !== undefined) {
      await this.deps.runStateWriter.setSpecStatus({
        specId,
        orgId,
        status: "needs_attention",
        notFromStatuses: ["merged", "needs_attention"],
      });
      return;
    }
    await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      await client.query(
        `UPDATE specs SET status = 'needs_attention' WHERE spec_id = $1 AND status NOT IN ('merged', 'needs_attention')`,
        [specId],
      );
    });
  }

  private async withScopedStore(orgId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    // TEST SEAM: an injected recording append needs no scope machinery — wrap it as an
    // EventStore so the work body is identical to the production path.
    if (this.deps.appendEvent !== undefined) {
      const appendEvent = this.deps.appendEvent;
      await work({ append: (event) => appendEvent(orgId, event) });
      return;
    }
    if (this.deps.runStateWriter !== undefined) {
      const writer = this.deps.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
    await runWithOrgScope(this.deps.pool, orgId, (client) => work(new PgEventStore(client)));
  }
}

/** Build the writer-rework steering note carrying the batch gate's failing output (the no-blind-rework carrier). */
export function buildGateReworkSteering(gateError: string, priorReworks: number): string {
  const attempt = priorReworks + 1;
  return (
    `Your change passed its own branch gates but FAILED the merge-time integrated-tree gate ` +
    `(the prospective merged state of main + the queued batch). This is an INTEGRATION-ONLY failure ` +
    `(e.g. a config/file the integrated tsconfig or lint now covers). Re-author to fix it. ` +
    `Rework attempt ${attempt}. The exact integrated-gate error:\n${gateError}`
  );
}

/**
 * Count the spec's prior `merge.batch.gate_rework_routed` (disposition `reworked`) events —
 * the bounded gate-rework budget key. The `events` table is unreadable to the de-privileged
 * data-plane role (0031 REVOKE), so read on the BYPASSRLS system pool with the org GUC still
 * applied on top (the same hop the replan cap uses).
 */
async function countPriorGateReworks(pool: pg.Pool, input: { specId: string; orgId: string }): Promise<number> {
  const readPool = getSystemPool() ?? pool;
  return runWithOrgScope(readPool, input.orgId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM events
        WHERE spec_id = $1 AND event_type = 'merge.batch.gate_rework_routed'
          AND payload ->> 'disposition' = 'reworked'`,
      [input.specId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}
