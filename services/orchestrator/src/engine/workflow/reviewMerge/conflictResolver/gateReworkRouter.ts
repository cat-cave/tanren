// The pre-merge / base-shift re-gate GATE-FAIL rework router (v35 — the
// re-gate-gate-fail-mis-classified-as-irreconcilable-conflict fix).
//
// THE BUG IT CLOSES: a spec that passed its OWN gates was queued to merge; main moved
// (`merge.behind`), so the branch was rebased onto the new base and RE-GATED. The re-gate's
// GATE TIER failed (lint/test/build on the new base) — but the rebase itself was CLEAN (no
// merge conflict). The resolver mis-classified that clean-rebase-but-failed-gate as a
// `merge.conflict.irreconcilable` and routed it to replan/escalate, STRANDING the spec at
// `needs_attention` (`persistent_failure`) when the WRITER could simply fix the code on the
// new base. (Gate-fail→rework already works on the per-iteration + BATCH paths — #591; this
// is the BASE-SHIFT RE-GATE path that was the last fragment routing gate-fail to "conflict".)
//
// THE FIX: a GATE-tier re-gate failure (distinct from a genuine merge CONFLICT, which still
// routes to the conflict resolver / replan, and from a checker/auditor rejection, which is a
// real does-not-fit replan) routes back to the WRITER for REWORK, carrying the re-gate's
// failing tier/step/output as steering so the writer fixes the RIGHT thing
// (no_silent_fallback — never rework blind). This REUSES the SAME never-discard
// re-author the batch-gate path (#591) and a conflict replan use (`buildReplanEnqueuer` +
// `buildGateReworkSteering`): re-open the spec to `open`, append the gate error as steering,
// enqueue a fresh re-author run. After the rework produces a new head, the spec re-queues.
//
// UNBOUNDED while PROGRESSING; escalate only at a FIXED POINT (apex v35 — intelligent
// non-convergence detection, NO hardcoded count). A spec whose re-gate error keeps CHANGING
// across reworks is making PROGRESS (the writer fixes one failure and surfaces the next — the
// 1000 → 1 trajectory) and the loop re-works UNBOUNDED. It is genuinely stuck only when the
// SAME re-gate error recurs (re-authoring produced no change to it) — a FIXED POINT the
// shared `convergenceDetector` detects. ONLY there does it ESCALATE as a LOUD
// `needs_attention` (`persistent_failure`), never a silent strand, never a count.

import type { GateReworkRouter, GateReworkRouteResult } from "../../../contracts/conflictResolution.js";
import type { EventStore } from "../../../eventStore.js";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { QueryClient } from "../../../data/orgScopedDb.js";
import { buildGateReworkSteering } from "../../../merge/batchGateReworkRouter.js";
import { SpecNotRunnableError } from "../../projectSpecErrors.js";
import { createLogger } from "../../../observability/logger.js";
import { findActiveOwnerRunForSpec } from "../../../merge/recoveryOwnership.js";
import { atReplanFixedPoint, gateErrorSignature, type ReplanEnqueuer } from "./replanRouter.js";

const log = createLogger("regate-gate-rework");

export interface SpecStatusGateReworkRouterDeps {
  /**
   * Tenant pool for RLS-scoped active-owner proof after SpecNotRunnableError.
   * QueryClient so workflow seams need no `as pg.Pool` cast; findActiveOwnerRunForSpec
   * narrows via isPool.
   */
  pool: QueryClient;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714 made the writer-undefined fallback unreachable
   * in production; the prior optional slot was a split-write hazard.
   */
  runStateWriter: RunStateWriter;
  /** REQUIRED tenant key (v68 fix). Every eventStore.append stamps this directly
   * rather than re-derive via a SELECT-join — a null org_id row trips RLS. */
  orgId: string;
  eventStore: EventStore;
  runId: string;
  projectId: string;
  prNumber: number;
  /**
   * Enqueues the writer-rework run (re-open + steering + run-create) — the never-discard
   * re-author on the new base. Production wires `buildReplanEnqueuer`; when absent the router
   * only flips status (degenerate/test path), never silently merging.
   */
  enqueuer?: ReplanEnqueuer;
  /** Reads the spec's prior gate-rework error signatures (the convergence-detector input). */
  priorReworks?: (input: { specId: string; orgId: string }) => Promise<string[]>;
}

/**
 * The production re-gate gate-fail rework router. On a GATE-tier re-gate failure it either
 * enqueues a fresh writer-rework run (re-author on the gate error as steering) or — ONLY at a
 * convergence FIXED POINT (the SAME gate error recurs) — escalates to `needs_attention`,
 * emitting the observable `merge.regate.gate_rework_routed` either way (never a silent strand).
 */
export class SpecStatusGateReworkRouter implements GateReworkRouter {
  constructor(private readonly deps: SpecStatusGateReworkRouterDeps) {}

  async routeGateFailToRework(input: { specId: string; gateError: string }): Promise<GateReworkRouteResult> {
    const orgId = this.deps.orgId;
    const priorSignatures = this.deps.priorReworks ? await this.deps.priorReworks({ specId: input.specId, orgId }) : [];
    const currentSignature = gateErrorSignature(input.gateError);
    // FIXED-POINT (no count): a spec whose re-gate error keeps CHANGING is making progress
    // (re-work UNBOUNDED). It is genuinely stuck only when the SAME gate error recurs
    // (re-authoring produced no change to it) — escalate LOUD instead of re-working
    // identically forever. The shared detector decides.
    if (await atReplanFixedPoint(priorSignatures, currentSignature)) {
      return {
        kind: "parking_required",
        message:
          `gate-rework fixed point for ${input.specId}: identical gate error recurs ` +
          `(prior ${priorSignatures.length}); settlement must park atomically. Gate: ${input.gateError}`,
      };
    }

    const steeringNote = buildGateReworkSteering(input.gateError, priorSignatures.length);
    if (this.deps.enqueuer === undefined) {
      return {
        kind: "parking_required",
        message: `gate-rework for ${input.specId} has no enqueuer — settlement must park atomically`,
      };
    }
    try {
      const run = await this.deps.enqueuer.enqueue({
        specId: input.specId,
        orgId: this.deps.orgId,
        projectId: this.deps.projectId,
        steeringNote,
        reopenStatus: "open",
      });
      await this.recordReworked(input, priorSignatures.length, steeringNote, run.replanRunId, run.plannerTaskId);
      return {
        kind: "owned",
        receipt: {
          kind: "writer_rework",
          specId: input.specId,
          run: { kind: "enqueued", replanRunId: run.replanRunId, plannerTaskId: run.plannerTaskId },
        },
      };
    } catch (error) {
      // BENIGN RACE: a concurrent tick already claimed the re-opened spec — a run IS being
      // driven, so this is not a strand. Record the routing observably (no new run id).
      if (error instanceof SpecNotRunnableError) {
        const live = await findActiveOwnerRunForSpec(
          this.deps.pool,
          this.deps.orgId,
          this.deps.projectId,
          input.specId,
          this.deps.runId,
        );
        if (live === undefined) {
          log.error(
            "re-gate gate-fail SpecNotRunnableError without active owner — fail closed",
            { specId: input.specId, reportedStatus: error.status },
            error,
          );
          return {
            kind: "parking_required",
            message:
              `SpecNotRunnableError without verified active owner for ${input.specId}; ` +
              `settlement must park. Gate: ${input.gateError}`,
          };
        }
        log.warn(
          "re-gate gate-fail rework verified active owner run",
          { specId: input.specId, runId: live.runId, status: live.status },
          error,
        );
        await this.recordReworked(input, priorSignatures.length, steeringNote, live.runId);
        return {
          kind: "owned",
          receipt: {
            kind: "writer_rework",
            specId: input.specId,
            run: { kind: "already_running", runId: live.runId },
          },
        };
      }
      // GENUINE FAILURE: the rework run could not be created AND no concurrent tick owns it.
      // A routed rework that cannot RUN is a genuine failure a human must see — escalate LOUD.
      log.error(
        "re-gate gate-fail rework FAILED to enqueue a run for the spec — escalating (never a silent strand)",
        { specId: input.specId },
        error,
      );
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: "parking_required",
        message: `gate-rework enqueue failed for ${input.specId} (${detail}); settlement must park. Gate: ${input.gateError}`,
      };
    }
  }

  /** Record the observable `merge.regate.gate_rework_routed` (disposition `reworked`) + the run lineage. */
  private async recordReworked(
    input: { specId: string; gateError: string },
    priorReworks: number,
    steeringNote: string,
    replanRunId?: string,
    plannerTaskId?: string,
  ): Promise<void> {
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      orgId: this.deps.orgId,
      eventType: "merge.regate.gate_rework_routed",
      payload: {
        integration: "native_queue",
        specId: input.specId,
        runId: this.deps.runId,
        prNumber: this.deps.prNumber,
        disposition: "reworked",
        gateError: input.gateError,
        priorReworks,
      },
    });
    // The OBSERVABLE run-enqueue lineage (only when a NEW run was created — the benign
    // already-claimed race did not; a concurrent tick emitted its own run.queued).
    if (replanRunId !== undefined && plannerTaskId !== undefined) {
      await this.deps.eventStore.append({
        runId: this.deps.runId,
        specId: input.specId,
        projectId: this.deps.projectId,
        orgId: this.deps.orgId,
        eventType: "recovery.replan_queued",
        payload: {
          runId: this.deps.runId,
          specId: input.specId,
          action: "replan_with_steering",
          steeringNote,
          replanRunId,
          plannerTaskId,
        },
      });
    }
  }
}
