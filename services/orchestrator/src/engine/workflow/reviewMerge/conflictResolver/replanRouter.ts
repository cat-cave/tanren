// The replan router (autonomy-engine.md §2b -- "intent stays alive"). On an
// irreconcilable conflict (or a resolution / re-gate that fails on a shifted base),
// ONE spec is routed back to the planner with the OTHER spec's change as new context
// -- so the intent is RE-PLANNED, never silently dropped or merged.
//
// CRITICAL (v35 -- the replan-routed-but-never-executed stall): routing a spec back to
// the planner is NOT just a status flip + an event. A routed spec must ACTUALLY RE-DRIVE
// -- a fresh re-plan run has to be ENQUEUED, or the spec sits forever in a state the
// walker reads as "occupying a slot" with no live run (the confirmed stall: the timeline
// ends at `merge.conflict.replan_routed → merge.dequeued`, then nothing, with NO
// `recovery.replan_queued` and the spec never re-driven). The old impl set the spec to
// `in_flight` -- which `classifySpecStatus` maps to the `in_flight` scheduling bucket, so
// the walker NEVER re-enqueues it, AND `createQueuedRunFromSpec`'s claim only fires on an
// `open` spec -- a dead end. This router now does the SAME thing the recovery
// `replan_with_steering` action does (the proven re-author-on-the-new-base mechanism):
//   (1) re-open the spec to `open` (the re-drivable status -- the walker enqueues it AND
//       the run-create claim can take it) and append the replan context as steering on
//       the spec, so the next planner pass re-authors the work ON the new base (intent
//       stays alive -- never-discard);
//   (2) ENQUEUE a fresh re-plan run (the same `createQueuedRunFromSpec` the walker/recovery
//       use) and emit `recovery.replan_queued` (carrying the `replanRunId`) so the re-plan
//       is OBSERVABLE -- never a silent stall;
//   (3) append the durable `merge.conflict.replan_routed` context event the next planner
//       pass reads.
//
// UNBOUNDED while PROGRESSING; escalate only at a FIXED POINT (apex v35 -- intelligent
// non-convergence detection, replacing the old fixed `MAX_BASE_SHIFT_REPLANS` cap). A spec
// re-planned against a DIFFERENT conflict each time is making PROGRESS -- the loop continues,
// no matter how many re-plans. It is GENUINELY stuck only when it is re-planned against the
// SAME conflict signature again (re-planning would just re-conflict identically) -- a proven
// FIXED POINT the shared `convergenceDetector` detects. There only does it ESCALATE as a
// LOUD `needs_attention` human decision (frees the slot, blocks only dependents) instead of
// enqueuing yet another run -- never a silent stall, never a hot-loop, never a count. It
// routes the status write through the run-state writer when wired (remote control plane) and
// otherwise runs the in-process org-scoped UPDATE.

import { createHash } from "node:crypto";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { QueryClient } from "../../../data/orgScopedDb.js";
import type { EventStore } from "../../../eventStore.js";
import type { ReplanRouter, ReplanRouteResult } from "../../../contracts/conflictResolution.js";
import { SpecNotRunnableError } from "../../projectSpecErrors.js";
import { createLogger } from "../../../observability/logger.js";
import { findActiveOwnerRunForSpec } from "../../../merge/recoveryOwnership.js";
import { type AttemptSignature, decideConvergence, fixedPointRuleJudgment } from "../../convergenceDetector.js";

const log = createLogger("replan-router");

/**
 * A stable CONFLICT SIGNATURE for a re-plan attempt -- a hash of the conflicting change /
 * new planning context the spec is being re-planned against. The fixed-point axis: a re-plan
 * against the SAME signature recurring is a stuck loop; a DIFFERENT signature is progress.
 */
export function conflictSignatureOf(newContext: string, otherSpecId?: string): string {
  return createHash("sha256")
    .update(`${otherSpecId ?? ""}${newContext}`)
    .digest("hex");
}

/**
 * A stable signature for an error string (a gate error, an integrated-gate failure) -- the
 * fixed-point axis the convergence detector keys "the SAME error recurred" off. Trimmed so
 * trivial whitespace differences do not read as progress. Shared by the batch-gate rework,
 * the pre-merge-gate self-heal, and the review-rework loops.
 */
export function gateErrorSignature(error: string): string {
  return createHash("sha256").update(error.trim()).digest("hex");
}

/**
 * Is the re-plan loop at a FIXED POINT? Assemble the prior conflict signatures (oldest→newest) +
 * the current one into the shared convergence detector's history (each attempt's
 * `failureSignature` = the conflict / gate-error signature it was routed against) and route the
 * escalation decision through the SHARED `decideConvergence` judge -- NOT a raw `=== "fixed_point"`
 * boolean (the disguised-K=2 the audit flagged). There is no answerer at this routing point (it
 * is a structural durable-signature decision), so `fixedPointRuleJudgment` is the principled
 * stand-in: a DIFFERENT conflict than last time ⇒ progress (keep re-planning, UNBOUNDED); the
 * SAME conflict RECURRING beyond a single transient repeat (a proven cycle / oscillation) ⇒
 * escalate a LOUD human decision. NO count -- the cycle detection itself is the loop-breaker.
 */
export async function atReplanFixedPoint(priorSignatures: ReadonlyArray<string>, current: string): Promise<boolean> {
  const history: AttemptSignature[] = [...priorSignatures, current].map((sig) => ({ failureSignature: sig }));
  const decision = await decideConvergence(history, (h) =>
    fixedPointRuleJudgment(
      h,
      () => "the re-plan / re-gate loop reached a FIXED POINT -- the identical conflict recurs with no new information",
    ),
  );
  return decision.decision === "escalate";
}

/**
 * One re-gate self-heal attempt's distilled signals -- a failure SIGNATURE (the stable
 * `tier:step` identity the writer was sent back to fix) PLUS an optional MAGNITUDE of the
 * remaining problem (e.g. the failing-step / diagnostic-line count parsed from the gate
 * output). The magnitude is what lets a SHRINKING-error trajectory at a stable signature
 * (50 → 20 → 5 errors, all the same `tier:step`) read as PROGRESS instead of a spurious
 * fixed point. Carried across iterations so the next attempt's detector sees the trajectory.
 */
export interface GateAttempt {
  signature: string;
  /** A NON-NEGATIVE remaining-problem magnitude (omit when the loop has no meaningful one). */
  magnitude?: number;
}

/**
 * A stack-agnostic MAGNITUDE of a re-gate failure's remaining problem: the count of non-empty
 * lines in the failing step's captured output (a generic "how much is still wrong" proxy --
 * NOT a tool-specific error-count parse, so it works for any declared toolchain). A writer
 * fixing one failure after another shrinks this even when the failing `tier:step` signature is
 * unchanged, so the trajectory reads as PROGRESS. Returns `undefined` for empty output (no
 * meaningful magnitude -- the detector then keys off the signature alone). NOT a count cap.
 */
export function outputMagnitude(output: string): number | undefined {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? undefined : lines.length;
}

/**
 * Is the re-GATE / re-review self-heal loop at a FIXED POINT? The MAGNITUDE-aware sibling of
 * `atReplanFixedPoint`: it threads BOTH the failure signature AND the remaining-problem
 * magnitude into the shared `decideConvergence` history, so a shrinking-error trajectory at an
 * UNCHANGED signature (50 → 20 → 5 errors, same `tier:step`) is recognized as PROGRESS (keep
 * re-working, UNBOUNDED) instead of halting as a spurious fixed point -- the bug the bare
 * signature-only path had. Only a GENUINE fixed point (the same signature recurring with NO
 * magnitude decrease) escalates, via the principled `fixedPointRuleJudgment` (no answerer at
 * this durable routing point). NO count -- the magnitude-aware cycle detection is the breaker.
 */
export async function atGateFixedPoint(
  priorAttempts: ReadonlyArray<GateAttempt>,
  current: GateAttempt,
): Promise<boolean> {
  const history: AttemptSignature[] = [...priorAttempts, current].map((attempt) => ({
    failureSignature: attempt.signature,
    ...(attempt.magnitude !== undefined && { magnitude: attempt.magnitude }),
  }));
  const decision = await decideConvergence(history, (h) =>
    fixedPointRuleJudgment(
      h,
      () =>
        "the re-gate / review self-heal loop reached a FIXED POINT -- the identical failure recurs " +
        "with no shrinking error count (no new information)",
    ),
  );
  return decision.decision === "escalate";
}

/**
 * Enqueue a fresh re-plan run for the (now-re-opened) spec -- the never-discard
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
 * Read the spec's prior re-plan CONFLICT SIGNATURES (oldest→newest) from the durable
 * `merge.conflict.replan_routed` events -- the input the shared convergence detector reasons
 * over. Production reads the `events` table org-scoped; a test injects a list. (Replaces the
 * old prior-replan COUNT: a count cannot tell "same conflict" from "different conflict", so
 * it could only enforce a hardcoded cap; the signatures let the detector see PROGRESS.)
 */
export interface PriorReplanReader {
  signatures(input: { specId: string; orgId: string }): Promise<string[]>;
}

export interface SpecStatusReplanRouterDeps {
  /**
   * Tenant pool for RLS-scoped active-owner proof after SpecNotRunnableError.
   * QueryClient so workflow seams need no `as pg.Pool` cast; findActiveOwnerRunForSpec
   * narrows via isPool.
   */
  pool: QueryClient;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714 made the writer-undefined fallback unreachable
   * in production.
   */
  runStateWriter: RunStateWriter;
  /** REQUIRED tenant key (v68 fix). Every eventStore.append stamps this directly
   * rather than re-derive via a SELECT-join -- a null org_id row trips RLS. */
  orgId: string;
  eventStore: EventStore;
  runId: string;
  projectId: string;
  /**
   * Enqueues the re-plan run (never-discard re-author on the new base). REQUIRED to
   * actually re-drive: when absent the router only flips status + records the context
   * (the legacy no-run-enqueued behavior) -- wiring it is what makes a routed replan RUN.
   */
  enqueuer?: ReplanEnqueuer;
  /** Reads the spec's prior re-plan conflict signatures (the convergence-detector input). */
  priorReplans?: PriorReplanReader;
  /** The status a routed-back spec returns to so it can be re-driven (default `open`). */
  replanStatus?: string;
}

export class SpecStatusReplanRouter implements ReplanRouter {
  constructor(private readonly deps: SpecStatusReplanRouterDeps) {}

  async routeBackToPlanner(input: {
    specId: string;
    newContext: string;
    otherSpecId?: string;
  }): Promise<ReplanRouteResult> {
    // FIXED-POINT (no hot-loop, no count): a spec re-planned against the SAME conflict
    // signature again is genuinely stuck -- re-planning would just re-conflict identically.
    // The shared detector decides progress (a different conflict ⇒ keep going, UNBOUNDED) vs
    // fixed point (the same conflict recurring ⇒ escalate a LOUD human decision).
    const signature = conflictSignatureOf(input.newContext, input.otherSpecId);
    const priorSignatures = this.deps.priorReplans
      ? await this.deps.priorReplans.signatures({ specId: input.specId, orgId: this.deps.orgId })
      : [];
    if (await atReplanFixedPoint(priorSignatures, signature)) {
      return {
        kind: "parking_required",
        message:
          `replan fixed point for ${input.specId}: the SAME conflict signature recurs ` +
          `(prior ${priorSignatures.length}); settlement must park atomically -- ${input.newContext}`,
      };
    }

    // (1)+(2) Re-open the spec to the re-drivable `open` status (the status the walker
    //     enqueues AND the run-create claim can take -- `in_flight` is a DEAD END here),
    //     append the replan context as steering so the next planner pass re-authors the
    //     work ON the new base (intent stays alive), and ENQUEUE the fresh re-plan run.
    //     The enqueuer owns the re-open + steering + run-create as ONE ordered unit (the
    //     re-open must COMMIT before the run-create's separate-connection claim reads it --
    //     the same ordering the recovery `replan_with_steering` action documents). When no
    //     enqueuer is wired (a degenerate/test path) we fall back to a plain status flip.
    const status = this.deps.replanStatus ?? "open";
    const enqueue = await this.enqueueReplan(input, status);
    if (enqueue.outcome === "no-enqueuer") {
      return {
        kind: "parking_required",
        message: `replan for ${input.specId} has no enqueuer wired -- settlement must park atomically`,
      };
    }
    if (enqueue.outcome === "failed") {
      const detail = enqueue.error instanceof Error ? enqueue.error.message : String(enqueue.error);
      return {
        kind: "parking_required",
        message:
          `replan enqueue failed for ${input.specId} (${detail}) -- settlement must park atomically; ` +
          input.newContext,
      };
    }

    // (3) Record the new planning context so the next planner pass re-authors the spec ON
    //     TOP of the other's change -- the durable carrier that keeps intent alive. Emitted
    //     ONLY now that a re-drive is CONFIRMED (a fresh run was enqueued, or a concurrent
    //     tick already claimed the re-opened spec → a run IS in flight) -- so a recorded
    //     `replan_routed` ALWAYS corresponds to a spec that is actually being re-driven,
    //     never a silent strand. The bounded cap counts these, so it counts only real routings.
    await this.deps.eventStore.append({
      runId: this.deps.runId,
      specId: input.specId,
      projectId: this.deps.projectId,
      orgId: this.deps.orgId,
      eventType: "merge.conflict.replan_routed",
      payload: {
        specId: input.specId,
        ...(input.otherSpecId !== undefined && { otherSpecId: input.otherSpecId }),
        newContext: input.newContext,
        replanStatus: status,
        // The fixed-point axis: which conflict this re-plan was routed against, so the next
        // routing's detector can tell "the same conflict recurred" (stuck) from "a different
        // conflict" (progress) -- never a count.
        conflictSignature: signature,
      },
    });

    // (4) Emit the OBSERVABLE `recovery.replan_queued` so the routed replan is never a
    //     silent stall -- it names the `replanRunId` the walker/worker will drive. Only the
    //     `enqueued` outcome created a NEW run (the observable id); the benign already-claimed
    //     race did NOT create a run (a concurrent tick owns the live re-drive), so there is no
    //     new run id to name -- the `replan_routed` routing above already marks it observable,
    //     and the concurrent tick emitted its own `run.queued`. No fabricated run id ever.
    if (enqueue.outcome === "enqueued") {
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
          steeringNote: input.newContext,
          replanRunId: enqueue.replanRunId,
          plannerTaskId: enqueue.plannerTaskId,
        },
      });
      return {
        kind: "owned",
        receipt: {
          kind: "planner_replan",
          specId: input.specId,
          run: {
            kind: "enqueued",
            replanRunId: enqueue.replanRunId,
            plannerTaskId: enqueue.plannerTaskId,
          },
        },
      };
    }
    // already-running with verified live run id
    return {
      kind: "owned",
      receipt: {
        kind: "planner_replan",
        specId: input.specId,
        run: { kind: "already_running", runId: enqueue.runId },
      },
    };
  }

  /**
   * Enqueue the re-plan run -- the never-discard re-author of the spec's work on the new
   * base. The outcome the caller routes on:
   *   - `enqueued`       -- a fresh re-plan run was created (the `replanRunId` is observable);
   *   - `already-running` -- a concurrent tick already claimed the re-opened spec
   *                         (`SpecNotRunnableError`): a run IS being driven, so this is a
   *                         BENIGN no-op, NOT a strand (the spec re-drives on the live run);
   *   - `failed`         -- a GENUINE enqueue failure with no run in flight (must escalate,
   *                         never silently strand the spec at `replan_routed`);
   *   - `no-enqueuer`    -- no enqueuer wired (the degenerate/test status-only path).
   */
  private async enqueueReplan(
    input: { specId: string; newContext: string },
    status: string,
  ): Promise<
    | { outcome: "enqueued"; replanRunId: string; plannerTaskId: string }
    | { outcome: "already-running"; runId: string }
    | { outcome: "failed"; error: unknown }
    | { outcome: "no-enqueuer" }
  > {
    if (this.deps.enqueuer === undefined) return { outcome: "no-enqueuer" };
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
      // that run, so this is not a strand -- log + treat as a confirmed re-drive.
      if (error instanceof SpecNotRunnableError) {
        const live = await findActiveOwnerRunForSpec(this.deps.pool, this.deps.orgId, input.specId);
        if (live === undefined) {
          log.error(
            "re-plan SpecNotRunnableError without an active owner run -- fail closed",
            { specId: input.specId, reportedStatus: error.status },
            error,
          );
          return {
            outcome: "failed",
            error: new Error(
              "SpecNotRunnableError without an independently verified active owner run (queued/running/paused)",
            ),
          };
        }
        log.warn(
          "re-plan enqueue found active owner run; treating as already_running",
          { specId: input.specId, runId: live.runId, status: live.status },
          error,
        );
        return { outcome: "already-running", runId: live.runId };
      }
      // GENUINE FAILURE: the enqueue could not create a run AND no concurrent tick owns it.
      // Surface it so the caller escalates -- NEVER swallow it into a silent strand.
      log.error(
        "re-plan enqueue FAILED to create a run for the routed spec -- escalating (never a silent replan_routed strand)",
        { specId: input.specId },
        error,
      );
      return { outcome: "failed", error };
    }
  }
}
