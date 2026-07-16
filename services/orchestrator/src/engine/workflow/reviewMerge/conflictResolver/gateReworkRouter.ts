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
import { buildGateReworkSteering } from "../../../merge/batchGateReworkRouter.js";
import { atReplanFixedPoint, gateErrorSignature, type ReplanEnqueuer } from "./replanRouter.js";

export interface SpecStatusGateReworkRouterDeps {
  /** Required tenant key carried into the atomic recovery preparation request. */
  orgId: string;
  runId: string;
  projectId: string;
  prNumber: number;
  /**
   * Owns steering, reopen, successor creation, and canonical routing events atomically.
   * Absence fails closed to parking_required; this router has no write fallback.
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
      const prepared = await this.deps.enqueuer.enqueue({
        specId: input.specId,
        orgId: this.deps.orgId,
        projectId: this.deps.projectId,
        steeringNote,
        reopenStatus: "open",
        oldRunId: this.deps.runId,
        route: {
          kind: "regate_writer_rework",
          prNumber: this.deps.prNumber,
          gateError: input.gateError,
          priorReworks: priorSignatures.length,
        },
      });
      if (prepared.kind === "owned") {
        return prepared.receipt.kind === "writer_rework"
          ? { kind: "owned", receipt: prepared.receipt }
          : { kind: "parking_failed", message: "recovery preparation returned the wrong owner kind" };
      }
      if (prepared.kind === "terminal_noop") return prepared;
      return { kind: "parking_failed", message: prepared.message };
    } catch (error) {
      return {
        kind: "parking_failed",
        message: `gate-rework preparation failed for ${input.specId}: ${String(error)}`,
      };
    }
  }
}
