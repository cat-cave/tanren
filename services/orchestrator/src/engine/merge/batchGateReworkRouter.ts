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
// UNBOUNDED while PROGRESSING; escalate only at a FIXED POINT (apex v35 — intelligent
// non-convergence detection, replacing the old fixed `MAX_BATCH_GATE_REWORKS` cap). A spec
// whose integrated-gate error keeps CHANGING across reworks is making PROGRESS (the writer
// is fixing one failure and surfacing the next — the 1000 → 1 errors trajectory) and the
// loop re-works UNBOUNDED. It is genuinely stuck only when the SAME integrated-gate error
// recurs (re-working produced no change to it) — a FIXED POINT the shared
// `convergenceDetector` detects. There only does it ESCALATE as a LOUD `needs_attention`
// (the `persistent_failure` path), never a silent strand, never a count.

import { getSystemPool, runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchGateReworkRouter } from "../contracts/batchMergeCoordinator.js";
import type { GateReworkRouteResult } from "../contracts/conflictResolution.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";
import type { EventStore } from "../eventStore.js";
import type { AppendEventInput } from "../eventStore.js";
import {
  atReplanFixedPoint,
  gateErrorSignature,
  type ReplanEnqueuer,
} from "../workflow/reviewMerge/conflictResolver/replanRouter.js";
import { buildReplanEnqueuer } from "../workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import { SpecNotRunnableError } from "../workflow/projectSpecErrors.js";
import { createLogger } from "../observability/logger.js";
import {
  findLiveNonterminalRunForSpec,
  isRecoveryTerminalSpecStatus,
  loadSpecStatusForRecovery,
} from "./recoveryOwnership.js";

const log = createLogger("batch-gate-rework");

export interface BatchGateReworkRouterDeps {
  pool: pg.Pool;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714's `runStateWriterFromEnv` always returns one, so
   * the old `runWithOrgScope + new PgEventStore` fallback was unreachable in production.
   */
  runStateWriter: RunStateWriter;
  /** Enqueues the writer-rework run (re-open + steering + run-create). Production wires `buildReplanEnqueuer`. */
  enqueuer?: ReplanEnqueuer;
  /** Reads the spec's prior gate-rework error signatures (the convergence-detector input). Production reads events. */
  priorReworks?: (input: { specId: string; orgId: string }) => Promise<string[]>;
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
  private readonly priorReworks: (input: { specId: string; orgId: string }) => Promise<string[]>;

  private readonly resolveOrg: (projectId: string) => Promise<string | null>;

  constructor(private readonly deps: BatchGateReworkRouterDeps) {
    this.enqueuer = deps.enqueuer ?? buildReplanEnqueuer(deps.pool, deps.runStateWriter);
    // runStateWriter is REQUIRED — the writer-undefined fallback is dropped.
    this.priorReworks = deps.priorReworks ?? ((input) => countPriorGateReworks(deps.pool, input));
    this.resolveOrg = deps.resolveOrg ?? ((projectId) => resolveProjectOrg(deps.pool, projectId));
  }

  async routeGateFailToRework(input: {
    projectId: string;
    culprit: MergeQueueEntry;
    gateError: string;
  }): Promise<GateReworkRouteResult> {
    const orgId = await this.resolveOrg(input.projectId);
    // A required-missing org is a LOUD hard failure (no_silent_fallback): without it the
    // spec cannot be re-worked OR escalated, so a gate-fail would silently strand — exactly
    // the bricking this router exists to prevent.
    if (orgId === null) {
      throw new Error(
        `cannot route gate-fail rework for spec ${input.culprit.specId}: project ${input.projectId} has no org`,
      );
    }

    const priorSignatures = await this.priorReworks({ specId: input.culprit.specId, orgId });
    const currentSignature = gateErrorSignature(input.gateError);
    // FIXED-POINT (no count): a spec whose integrated-gate error keeps CHANGING is making
    // progress (re-work UNBOUNDED). It is genuinely stuck only when the SAME gate error
    // recurs (re-working produced no change to it) — escalate LOUD instead of re-working
    // identically forever. The shared detector decides.
    if (await atReplanFixedPoint(priorSignatures, currentSignature)) {
      const message = await this.escalate(orgId, input, priorSignatures.length);
      return {
        kind: "parked",
        receipt: { kind: "needs_attention", specId: input.culprit.specId, source: "writer_rework" },
        message,
      };
    }

    const existingStatus = await loadSpecStatusForRecovery(this.deps.pool, input.culprit.specId);
    if (existingStatus !== undefined && isRecoveryTerminalSpecStatus(existingStatus)) {
      const message = await this.escalateEnqueueFailure(
        orgId,
        input,
        new Error(`spec is terminal (${existingStatus}) and cannot own writer rework`),
      );
      return {
        kind: "parked",
        receipt: { kind: "needs_attention", specId: input.culprit.specId, source: "writer_rework" },
        message,
      };
    }

    const steeringNote = buildGateReworkSteering(input.gateError, priorSignatures.length);
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
      await this.recordReworked(orgId, input, priorSignatures.length, steeringNote, run.replanRunId, run.plannerTaskId);
      return {
        kind: "owned",
        receipt: {
          kind: "writer_rework",
          specId: input.culprit.specId,
          run: { kind: "enqueued", replanRunId: run.replanRunId, plannerTaskId: run.plannerTaskId },
        },
      };
    } catch (error) {
      // SpecNotRunnableError is NEVER ownership alone — independently prove a live run.
      if (error instanceof SpecNotRunnableError) {
        const live = await findLiveNonterminalRunForSpec(this.deps.pool, input.culprit.specId);
        if (live !== undefined) {
          log.warn(
            "gate-fail rework found the spec already claimed; verified a live nonterminal run owns it",
            { specId: input.culprit.specId, runId: live.runId, status: live.status },
            error,
          );
          await this.recordReworked(orgId, input, priorSignatures.length, steeringNote, live.runId);
          return {
            kind: "owned",
            receipt: {
              kind: "writer_rework",
              specId: input.culprit.specId,
              run: { kind: "already_running", runId: live.runId },
            },
          };
        }
        log.error(
          "gate-fail rework SpecNotRunnableError without a live nonterminal run — fail closed",
          { specId: input.culprit.specId, reportedStatus: error.status },
          error,
        );
        const message = await this.escalateEnqueueFailure(
          orgId,
          input,
          new Error("SpecNotRunnableError without an independently verified live nonterminal run"),
        );
        return {
          kind: "parked",
          receipt: { kind: "needs_attention", specId: input.culprit.specId, source: "writer_rework" },
          message,
        };
      }
      log.error(
        "gate-fail rework FAILED to enqueue a run for the culprit spec — escalating (never a silent strand)",
        { specId: input.culprit.specId },
        error,
      );
      const message = await this.escalateEnqueueFailure(orgId, input, error);
      return {
        kind: "parked",
        receipt: { kind: "needs_attention", specId: input.culprit.specId, source: "writer_rework" },
        message,
      };
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
        orgId,
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
          orgId,
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

  /** ESCALATE: the rework loop is at a FIXED POINT (the same gate error recurs) — park
   * `needs_attention` (loud, frees the slot). No count — the fixed point IS the trigger.
   *
   * Task #48 Site I: the aux `merge.batch.gate_rework_routed` event is emitted
   * BEFORE the load-bearing atomic pair (spec `needs_attention` flip +
   * `dag.spec.needs_attention` event) — per Plan §4 trade-off note. The aux
   * event is observable lineage; the load-bearing pair is the actual park.
   * Atomicity replaces best-effort on the pair. */
  private async escalate(
    orgId: string,
    input: { projectId: string; culprit: MergeQueueEntry; gateError: string },
    priorReworks: number,
  ): Promise<string> {
    const message =
      `the autonomous self-heal reached a FIXED POINT re-working this spec for an integrated-tree gate ` +
      `failure: the SAME batch-gate error recurs after re-authoring (no change to it), so a human must ` +
      `intervene. Latest gate error: ${input.gateError}`;
    // Aux event first (observable lineage of the routing decision).
    await this.withScopedStore(orgId, (store) =>
      store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        orgId,
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
      }),
    );
    // Load-bearing atomic pair: spec park + the loud `dag.spec.needs_attention` event.
    await this.parkSpecAtomic(orgId, input.culprit.specId, {
      runId: input.culprit.runId,
      specId: input.culprit.specId,
      projectId: input.projectId,
      orgId,
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "strand",
        specId: input.culprit.specId,
        reason: "persistent_failure",
        terminalRuns: [{ runId: input.culprit.runId, status: "halted" }],
        attempts: priorReworks,
        message,
      },
    });
    return message;
  }

  /** ESCALATE an enqueue failure: a rework whose run could not be created is genuinely stuck.
   *
   * Task #48 Site I (variant): same aux-then-atomic-pair shape as `escalate`. */
  private async escalateEnqueueFailure(
    orgId: string,
    input: { projectId: string; culprit: MergeQueueEntry; gateError: string },
    error: unknown,
  ): Promise<string> {
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      `the autonomous self-heal routed this spec back to the writer to fix an integrated-tree gate ` +
      `failure but could NOT enqueue the rework run (${detail}) — a human must intervene. ` +
      `Gate error: ${input.gateError}`;
    await this.withScopedStore(orgId, (store) =>
      store.append({
        runId: input.culprit.runId,
        specId: input.culprit.specId,
        projectId: input.projectId,
        orgId,
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
      }),
    );
    await this.parkSpecAtomic(orgId, input.culprit.specId, {
      runId: input.culprit.runId,
      specId: input.culprit.specId,
      projectId: input.projectId,
      orgId,
      eventType: "dag.spec.needs_attention",
      payload: {
        source: "strand",
        specId: input.culprit.specId,
        reason: "persistent_failure",
        terminalRuns: [{ runId: input.culprit.runId, status: "halted" }],
        attempts: 0,
        message,
      },
    });
    return message;
  }

  /** Task #48 Site I: ATOMIC spec park + `dag.spec.needs_attention` event in
   * ONE org-scoped transaction (control plane when wired, else in-process via
   * the same shared applier). Replaces the prior `parkSpec()` + separate
   * append — the load-bearing pair is no longer split.
   *
   * TEST SEAM: when `deps.appendEvent` is injected (no-DB unit run), fall back
   * to the legacy split (a guarded spec UPDATE on the test pool + the
   * injected event recorder) so test assertions still capture the event
   * without needing a real Postgres + RLS. The production paths always wire
   * a real writer OR a real pool, so the seam-bound atomicity is preserved
   * where it matters; the unit-test fallback is an explicit narrow concession
   * (the contract is exercised end-to-end in the conformance suite). */
  private async parkSpecAtomic(orgId: string, specId: string, event: AppendEventInput): Promise<void> {
    const spec = { specId, orgId, status: "needs_attention", notFromStatuses: ["merged", "needs_attention"] };
    // Audit D-R3.2: the writer (REQUIRED) is the single-source atomic park; the
    // test-seam split is kept ONLY for `deps.appendEvent`-injected unit runs (no DB,
    // no real writer attached on the test pool).
    if (this.deps.appendEvent !== undefined) {
      // TEST SEAM split fallback (no DB / no real writer wired on the test pool).
      await runWithOrgScope(this.deps.pool, orgId, async (client) => {
        await client.query(
          `UPDATE specs SET status = 'needs_attention' WHERE spec_id = $1 AND status NOT IN ('merged', 'needs_attention')`,
          [specId],
        );
      });
      await this.deps.appendEvent(orgId, event);
      return;
    }
    await this.deps.runStateWriter.updateSpecWithEvent({ spec, event });
  }

  private async withScopedStore(orgId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    // TEST SEAM: an injected recording append needs no scope machinery — wrap it as an
    // EventStore so the work body is identical to the production path.
    if (this.deps.appendEvent !== undefined) {
      const appendEvent = this.deps.appendEvent;
      await work({ append: (event) => appendEvent(orgId, event) });
      return;
    }
    const writer = this.deps.runStateWriter;
    await runWithJobOrgId(orgId, () => work(writer));
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
 * Read the spec's prior `merge.batch.gate_rework_routed` (disposition `reworked`) gate-error
 * SIGNATURES, oldest→newest — the shared convergence detector's input. The `events` table is
 * unreadable to the de-privileged data-plane role (0031 REVOKE), so read on the BYPASSRLS
 * system pool with the org GUC applied on top (the same hop the replan reader uses).
 */
async function countPriorGateReworks(pool: pg.Pool, input: { specId: string; orgId: string }): Promise<string[]> {
  const readPool = getSystemPool() ?? pool;
  return runWithOrgScope(readPool, input.orgId, async (client) => {
    const result = await client.query<{ payload: { gateError?: string } }>(
      `SELECT payload
         FROM events
        WHERE spec_id = $1 AND event_type = 'merge.batch.gate_rework_routed'
          AND payload ->> 'disposition' = 'reworked'
        ORDER BY ts ASC, id ASC`,
      [input.specId],
    );
    return result.rows.map((row) => gateErrorSignature(row.payload.gateError ?? ""));
  });
}
