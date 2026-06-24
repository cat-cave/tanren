// The planner-loop workflow's run-FINALIZE helpers, extracted from
// `plannerRun.ts` (file-size + complexity caps). All terminal `UPDATE runs`
// transitions the workflow drives go through {@link FinalizeRunState}.
//
// `buildFinalizeRunState` returns a closure that — when the
// worker injects a remote finalizer (`input.finalizeRun`, remote-writes on) —
// routes the terminal UPDATE through the control-plane endpoint; otherwise it
// runs the SAME in-process UPDATE the workflow always has (the
// `directSql`/`directParams` are byte-identical to the prior write, so the
// default path + its mutation suite are unchanged). The `fromStatuses` guard is
// what the remote endpoint applies for exactly-once.

import type { Allocator, ReleaseReason, RunnerAllocation, RunnerHandle } from "../contracts/allocator.js";
import { asSshRunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { AllocatorReleaseFinalizer } from "../contracts/releaseFinalizer.js";
import { CodexUsageLimitError } from "../providers/codex.js";
import type { EventName, EventPayload } from "../events/index.js";
import { removeRunWorkspaceDir, WorkspaceBootstrapError } from "../workspace/index.js";
import { AncestorNotReadyError } from "../dag/jjLocalIntegration.js";
import { applyTerminalOutcome, type DispositionSeams } from "./plannerRunRedrive.js";
import type { NonPassDetail, TerminalOutcome } from "./runFinalizeAuthority.js";
import { resolveWorkflowThrow, type WorkflowErrorDisposition } from "./workflowErrorDisposition.js";
import type { PreparedRunWorkspace } from "./plannerRunWorkspace.js";
import type { MergeForRunResult } from "./reviewMerge/index.js";
import type { PlannerRunContext, PlannerRunResult, RunPlannerLoopInput } from "./plannerRun.js";
import { finalizeRunCompletedAtomic } from "./runCompletedAtomic.js";
import type { SubtaskLoopOutcome } from "./subtaskLoop.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("run-workspace");

// Dimension D per-run credential-scoping seam: re-exported here (alongside the
// other lifecycle-write helpers) so `plannerRun.ts` imports it from a module it
// already depends on, keeping that file's dependency count under the cap.
export { applyScopedRunCredentials, type RunCredentialScoping } from "./plannerRunScopedCreds.js";

/** The `runner.allocated` event payload — runner id/image + the SSH handle's public fields. */
export function runnerPayload(allocation: RunnerAllocation) {
  // The allocation's `target` is the opaque RunnerHandle; the event payload carries
  // the SSH handle's public reach fields, so narrow to the SSH shape here.
  const handle = asSshRunnerHandle(allocation.target);
  return {
    runnerId: allocation.runnerId,
    imageSha: allocation.imageSha,
    target: {
      host: handle.host,
      port: handle.port,
      username: handle.username,
      hostKeyFingerprint: handle.hostKeyFingerprint,
    },
  };
}

/** Finalize the run's terminal state, direct (in-process) or remote (control plane). */
export type FinalizeRunState = (
  status: string,
  outcome: string,
  fromStatuses: string[],
  directSql: string,
  directParams: unknown[],
) => Promise<void>;

/** Build the run's terminal-finalize closure (remote when wired, else in-process). */
export function buildFinalizeRunState(input: RunPlannerLoopInput, runId: string): FinalizeRunState {
  return async (status, outcome, fromStatuses, directSql, directParams) => {
    if (input.finalizeRun !== undefined) {
      await input.finalizeRun({ runId, status, outcome, fromStatuses });
      return;
    }
    await input.pool.query(directSql, directParams);
  };
}

/**
 * drive the run's `running` transition, routing through the
 * lifecycle writer when wired (remote) — else the byte-identical in-process
 * `UPDATE runs ... started_at = now()`. The remote path requires the run's org
 * (the seam is only wired when it is known).
 */
export async function markRunRunning(input: RunPlannerLoopInput, context: PlannerRunContext): Promise<void> {
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  if (input.runStateWriter !== undefined && orgId !== undefined) {
    await input.runStateWriter.setRunStatus({ runId: context.runId, orgId, status: "running", setStartedAt: true });
    return;
  }
  await input.pool.query("UPDATE runs SET status = 'running', started_at = now() WHERE run_id = $1", [context.runId]);
}

/**
 * set the spec's status, routing through the lifecycle writer
 * when wired (remote) — else the byte-identical in-process `UPDATE specs`. The
 * remote path requires the run's org (the seam is only wired when it is known).
 */
export async function setSpecStatus(
  input: RunPlannerLoopInput,
  context: PlannerRunContext,
  status: string,
): Promise<void> {
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  if (input.runStateWriter !== undefined && orgId !== undefined) {
    await input.runStateWriter.setSpecStatus({ specId: context.specId, orgId, status });
    return;
  }
  await input.pool.query("UPDATE specs SET status = $2 WHERE spec_id = $1", [context.specId, status]);
}

/** Finalize a non-pass loop outcome to a halted run (distinct outcome preserves WHY). */
export async function finalizeNonPass(
  finalizeRunState: FinalizeRunState,
  runId: string,
  outcome: "window_exhausted" | "convergence_stalled" | "halted",
): Promise<void> {
  await finalizeRunState(
    "halted",
    outcome,
    // A non-pass finalize moves a still-running/queued run to halted; the direct
    // SQL is byte-identical to the prior unguarded UPDATE (the guard only bites
    // server-side on the remote path, for exactly-once).
    ["running", "queued"],
    "UPDATE runs SET status = 'halted', outcome = $2, ended_at = now() WHERE run_id = $1",
    [runId, outcome],
  );
}

/**
 * Build the {@link DispositionSeams} from the workflow's run/spec write closures — the
 * SINGLE place a terminal outcome's lifecycle writes are applied (re-drive: run halted +
 * spec → `open`; genuine-halt: run failed + spec → `needs_attention`). Reused by every
 * terminal site so the disposition is applied identically.
 *
 * Task #48 (run/spec atomicity sweep): the new `updateSpecAtomic` /
 * `finalizeGenuineHaltAtomic` seams route the spec flip + dag event AND the
 * genuine-halt run finalize + `run.failed` event through ONE atomic
 * transaction each (the `RunStateWriter.updateSpecWithEvent` /
 * `finalizeRunWithEvent` seams — Plan §4 Site A/B). The legacy
 * `finalizeNonPass` / `setSpecStatus` / `finalizeRunState` seams remain for
 * the non-terminal-pair paths (the re-drive's run halt is unpaired today;
 * the merge-stage `merged` flip + `run.completed` are owned by
 * `finalizeMergeOutcome`).
 */
function dispositionSeams(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
): DispositionSeams {
  const orgId = typeof context.orgId === "string" ? context.orgId : undefined;
  return {
    finalizeRunState,
    finalizeNonPass: (outcome) => finalizeNonPass(finalizeRunState, context.runId, outcome),
    setSpecStatus: (status) => setSpecStatus(input, context, status),
    updateSpecAtomic: async (spec, event) => {
      // Atomic path — REQUIRES both the writer + a known org so the row UPDATE
      // + event INSERT share ONE org-scoped transaction server-side. When
      // either is missing fall back to the legacy split (the same shape the
      // pre-#48 code used) so the unit-test harness — which wires neither —
      // keeps working unchanged.
      if (input.runStateWriter !== undefined && orgId !== undefined) {
        await input.runStateWriter.updateSpecWithEvent({
          spec: {
            specId: context.specId,
            orgId,
            status: spec.status,
            ...(spec.notFromStatuses !== undefined && { notFromStatuses: spec.notFromStatuses }),
          },
          event,
        });
        return;
      }
      await setSpecStatus(input, context, spec.status);
      // The fallback emits via the existing event recorder so the
      // unit-test path captures it identically.
      await appendEvent(event.eventType, event.payload, event.taskId);
    },
    finalizeGenuineHaltAtomic: async (event) => {
      // Genuine-halt run finalize + `run.failed` event in ONE org-scoped
      // transaction. Same writer/org fallback rule as `updateSpecAtomic`.
      if (input.runStateWriter !== undefined && orgId !== undefined) {
        await input.runStateWriter.finalizeRunWithEvent({
          finalize: {
            runId: context.runId,
            orgId,
            status: "failed",
            outcome: "failed",
            fromStatuses: ["running", "queued"],
          },
          event,
        });
        return;
      }
      // Fallback: the legacy seam writes the row, then the existing
      // event recorder writes the event — split but byte-identical to
      // the pre-#48 path.
      await finalizeRunState(
        "failed",
        "failed",
        ["running", "queued"],
        "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
        [context.runId],
      );
      await appendEvent(event.eventType, event.payload, event.taskId);
    },
  };
}

/**
 * UNIFIED RUN-FINALIZE (apex v35): route a NON-PASS planner-loop exit (the writer never
 * converged / a usage window exhausted / a convergence stall / a merge-gate budget spent /
 * a review stalled) through the ONE finalize authority. ALL non-pass exits are TRANSIENT —
 * the spec RE-DRIVES (run halts recoverable, spec → `open`, `dag.spec.redriven`), bounded by
 * the consecutive-same-failure counter (a spec stalling the SAME way K times → genuine-halt).
 * This REPLACES the old `finalizeNonPassAndPark`, which PARKED every non-pass exit at
 * `needs_attention` — the whack-a-mole bug (a transient stall mis-classified as a human-
 * decision). `needs_attention` is now reached ONLY when the authority decides genuine-halt.
 */
export async function finalizeNonPassOutcome(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  detail: NonPassDetail,
): Promise<void> {
  await applyTerminalOutcome(
    { kind: "non_pass", detail },
    { appendEvent, input, context },
    dispositionSeams(input, finalizeRunState, context, appendEvent),
  );
}

/** The non-pass loop outcome → the authority's public-safe sub-reason (the diagnostic detail). */
export function nonPassDetailFor(outcome: SubtaskLoopOutcome): NonPassDetail {
  if (outcome.kind === "window_exhausted") return "window_exhausted";
  if (outcome.kind === "convergence_stalled") return "convergence_stalled";
  return "halted";
}

/**
 * UNIFIED RUN-FINALIZE (apex v35): finalize the run + spec for the merge stage's terminal
 * outcome, routing the spec disposition through the ONE finalize authority's merge-outcome
 * map (`decideRunDisposition` → `kind: "merge"`):
 *   - `merged` → CONVERGE: run completed/ok, spec `merged`.
 *   - native_queue `queued` → run completed/ok, spec left NON-done (Tanren still owns the
 *     merge; the coordinator's DRIVE pass marks it `merged` only after the PR actually lands).
 *   - `needs_attention` → GENUINE-HALT: a real human-decision (HITL hold / changes-requested
 *     at land time) — run failed, spec `needs_attention` (the ONLY merge-stage park).
 *   - `blocked` (a transient authority refusal / CAS race) / `conflict` (resolvable) /
 *     `handed_off` / non-native `queued` / `failed` → RE-DRIVE: run halts recoverable, spec →
 *     `open`, the walker re-attempts. These were the whack-a-mole parks now folded to re-drive
 *     (a transient hold is NOT a human-decision; the work is never discarded).
 */
export async function finalizeMergeOutcome(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  merge: Pick<MergeForRunResult, "outcome" | "integration">,
): Promise<void> {
  const { outcome, integration } = merge;
  // A native_queue `queued` enqueue is the coordinator's continuation — the RUN completes
  // ok (the coordinator drives the actual land), the spec is left non-done. Handle it
  // explicitly here; every OTHER merge outcome routes through the unified authority.
  if (outcome === "merged" || (outcome === "queued" && integration === "native_queue")) {
    if (outcome === "merged") await setSpecStatus(input, context, "merged");
    // Atomic run-completed (R5 #1 / task #49) — row + run.completed event in
    // ONE tx via the new seam; same writer/org fallback as `finalizeGenuineHaltAtomic`.
    await finalizeRunCompletedAtomic(input, finalizeRunState, context, appendEvent);
    return;
  }
  // `needs_attention` (genuine human-decision) → genuine-halt; every other hold/conflict/
  // handoff/failed/non-native-queued → re-drive. The authority owns the bucket; the appliers
  // own the run/spec writes (the genuine-halt lands the run `failed` + parks the spec).
  await applyTerminalOutcome(
    { kind: "merge", mergeOutcome: outcome },
    { appendEvent, input, context },
    dispositionSeams(input, finalizeRunState, context, appendEvent),
  );
}

/** The bits the workflow's catch-path error finalizer needs from the run. */
export interface WorkflowErrorContext {
  finalizeRunState: FinalizeRunState;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  workspacePath: string;
  // NEVER-STRAND: the loop input + run context so a thrown-error finalize can re-drive
  // (→ `open`) or park (→ `needs_attention`) the SPEC — never strand it at `in_flight`.
  input: RunPlannerLoopInput;
  context: PlannerRunContext;
}

/**
 * SELF-HEAL (apex v35): emit the loud `workspace.bootstrap_deferred` event WHEN the workspace-PREP
 * `just bootstrap` (deps install) failed and was DEFERRED to the gate's self-healing path (see
 * `PreparedRunWorkspace.prepBootstrapDeferred`). A no-op when the prep bootstrap succeeded. The mise
 * PROVISION step is NOT writer-fixable and already threw terminally inside `prepareRunWorkspace`. The
 * command is prelude-free + the output tail bounded, so no app-secret value reaches the payload.
 */
export async function emitPrepBootstrapDeferred(
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  workspacePath: string,
  deferred: PreparedRunWorkspace["prepBootstrapDeferred"],
): Promise<void> {
  if (deferred === undefined) return;
  await appendEvent("workspace.bootstrap_deferred", {
    workspacePath,
    command: deferred.command,
    exitCode: deferred.exitCode,
    timedOut: deferred.timedOut,
    outputTail: deferred.outputTail,
  });
}

/**
 * UNIFIED RUN-FINALIZE (apex v35): finalize the run+spec for a thrown run-error through the
 * ONE finalize authority. EVERY thrown error normalizes into a {@link TerminalOutcome} the
 * authority maps to a bucket:
 *
 *   - an `AncestorNotReadyError` is a BENIGN WAIT (the dependent ran ahead of a non-terminal
 *     ancestor that has not published its head) ⇒ a NO-FAULT RE-DRIVE (run halts recoverable,
 *     spec → `open`); it ALSO emits the diagnostic `dag.spec.ancestor_not_ready` (it never
 *     counts toward the consecutive-same-failure cap — the ancestor WILL publish).
 *   - a `WorkspaceBootstrapError` / `CodexUsageLimitError` are RECOVERABLE / TRANSIENT
 *     (deps-install hiccup / usage window) ⇒ RE-DRIVE (the spec re-attempts), each emitting
 *     its own diagnostic event (`workspace.failed` / `usage.window.pressure`).
 *   - any OTHER error is a RANDOM / TRANSIENT / INTERNAL fault ⇒ RE-DRIVE; ONLY a
 *     credential misconfiguration genuine-halts immediately, and the SAME classified failure
 *     K consecutive times genuine-halts as a persistent failure.
 *
 * No branch here PARKS a transient fault — `needs_attention` is reached ONLY when the
 * authority decides genuine-halt. This collapses the old per-branch park logic (the
 * whack-a-mole) into the ONE decision. EVERY path finalizes BOTH the run's terminal status
 * AND the spec's, returning the {@link WorkflowErrorDisposition} `finalizeWorkflowThrow` acts on.
 */
export async function finalizeWorkflowError(
  error: unknown,
  ctx: WorkflowErrorContext,
): Promise<WorkflowErrorDisposition> {
  // Emit the per-error DIAGNOSTIC event (the timeline still shows WHY the run failed) BEFORE
  // routing the spec disposition through the unified authority — these are observability, not
  // a separate terminal behavior.
  const outcome = await emitDiagnosticAndNormalize(error, ctx);
  const bucket = await applyTerminalOutcome(
    outcome,
    ctx,
    dispositionSeams(ctx.input, ctx.finalizeRunState, ctx.context, ctx.appendEvent),
  );
  return bucket === "genuine_halt" ? "genuine_halt" : "re_drive";
}

/**
 * Emit the per-error-class DIAGNOSTIC event and NORMALIZE the thrown error into the
 * {@link TerminalOutcome} the authority decides over. The diagnostic events are the
 * observable timeline detail; the disposition (re-drive vs genuine-halt) is the authority's.
 */
async function emitDiagnosticAndNormalize(error: unknown, ctx: WorkflowErrorContext): Promise<TerminalOutcome> {
  if (error instanceof AncestorNotReadyError) {
    // BENIGN WAIT (tanren-owns-the-engine.md §3): surface the not-yet-ready ancestor + its
    // non-terminal phase, then re-drive with NO fault (it never counts toward the cap).
    await ctx.appendEvent("dag.spec.ancestor_not_ready", {
      specId: ctx.context.specId,
      runId: ctx.context.runId,
      ancestorSpecId: error.specId,
      ancestorPhase: error.phase === "in_flight" ? "in_flight" : "pending",
    });
    return { kind: "ancestor_wait" };
  }
  if (error instanceof WorkspaceBootstrapError) {
    // A deps-install / bootstrap hiccup the workspace could not build through — TRANSIENT.
    // Surface `workspace.failed`, then re-drive (the classifier maps it to `workspace`, a
    // retriable code; the consecutive-same-failure cap escalates a persistently-broken one).
    await ctx.appendEvent("workspace.failed", { workspacePath: ctx.workspacePath, message: error.message });
    return { kind: "error", error };
  }
  if (error instanceof CodexUsageLimitError) {
    // Authenticated but out of quota mid-loop (PROJECT_BRIEF §4.3): a recoverable window
    // state, TRANSIENT. Surface the pressure signal, then re-drive (the walker re-attempts
    // once the window recovers; the `usage_limit` code is retriable).
    await ctx.appendEvent("usage.window.pressure", {
      provider: "openai",
      slot: "primary",
      usedPercent: 100,
      resetsAt: new Date().toISOString(),
    });
    return { kind: "error", error };
  }
  // Any other error: a RANDOM / TRANSIENT / INTERNAL fault (or a credential misconfiguration
  // the authority genuine-halts). The classifier keys off the error CLASS name.
  return { kind: "error", error };
}

/**
 * SINGLE-FINALIZE INVARIANT (apex v35): the workflow `catch` body — finalize the run+spec ONCE
 * ({@link finalizeWorkflowError}), then `resolveWorkflowThrow`: a `re_driven` disposition RETURNS a
 * recoverable-halt {@link PlannerRunResult} normally (the walker's successor run is the continuation —
 * NEVER re-throw into the worker's strand path, the #580 double-finalize); else re-throw WRAPPED so the
 * worker skips its already-done finalize.
 */
export async function finalizeWorkflowThrow(error: unknown, ctx: WorkflowErrorContext): Promise<PlannerRunResult> {
  const disposition = await finalizeWorkflowError(error, ctx);
  return resolveWorkflowThrow(disposition, error, () => ({
    runId: ctx.context.runId,
    workspacePath: ctx.workspacePath,
    outcome: { kind: "halted", loopCount: 0, reason: "re_driven" },
    reDriven: true,
  }));
}

// The spec-run trigger pre-creates a queued 'plan' task + job_queue row for the
// async worker path. The workflow executes the run directly and the loop creates
// its own planner task, so the pre-created artifacts are vestigial — cancel them
// so the run does not carry a dangling queued task.
export async function supersedeQueuedPlannerTask(input: RunPlannerLoopInput, runId: string): Promise<void> {
  // the vestigial `plan` task cancel routes through the lifecycle
  // writer when wired (remote), else the byte-identical in-process write. The
  // `job_queue` cancel always runs in-process — `job_queue` is a cross-org system
  // table OUTSIDE RLS that the data plane keeps writing directly.
  if (input.runStateWriter === undefined) {
    await input.pool.query(
      "UPDATE tasks SET status = 'cancelled', outcome = 'cancelled', ended_at = now() WHERE run_id = $1 AND kind = 'plan' AND status = 'queued'",
      [runId],
    );
  } else {
    await input.runStateWriter.supersedeQueuedPlannerTask({ runId });
  }
  await input.pool.query("UPDATE job_queue SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'", [runId]);
}

// SECURITY-BASELINE CLEANUP-PROOF (tanren-direction.md § "Security Baseline":
// "Release events prove cleanup and list residual resources, if any."). The runner is an
// untrusted-code surface; the audit trail must record WHETHER its run-end teardown succeeded, not
// assume it. `runner.released` narrates the intent; `release.finalized` is the PROOF — `cleanedUp:
// false` + the runner listed as a residual resource (+ a non-secret `failureReason`) when the release
// throws, so an orphan sweeper / operator reconciles the leak (the allocator still owns destroy/wipe).
//
// Called from the run's `finally`, so it MUST NOT re-throw (a throw would mask the run's real failure
// the catch already finalized + re-raised). `runWorkspace` is layer 1 of the run-sandbox disk-leak fix
// (≈204 GB incident): BEFORE release, the run's `/workspace/runs/<runId>` dir is removed over SSH — the
// inline reclaim of the clone+build tree on a STATIC reused runner (a cheap no-op on an EPHEMERAL one
// the release destroys anyway). The `rm` NEVER throws — a failure is logged + tolerated like the leak.
export async function releaseRunnerWithCleanupProof(
  allocator: Allocator,
  runnerId: string,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  runWorkspace: { ssh: CommandSubstrate; target: RunnerHandle; runId: string },
  reason: ReleaseReason = "completed",
): Promise<void> {
  // Layer 1: remove the run's sandbox dir before release. Tolerant — a failure is
  // logged (the dir is left for the periodic reaper, layer 2, to reclaim) and never
  // re-thrown, so it cannot mask the run's real failure in the caller's `finally`.
  const teardown = await removeRunWorkspaceDir(runWorkspace.ssh, runWorkspace.target, runWorkspace.runId);
  if (!teardown.removed) {
    log.warn("failed to remove sandbox at end of run (reaper will reclaim)", {
      runId: runWorkspace.runId,
      reason: teardown.reason ?? "unknown",
    });
  }
  await appendEvent("runner.released", { runnerId });
  // Release through the RELEASE FINALIZER seam: it owns the release + returns a
  // reconcilable outcome WITHOUT throwing (a throw here would mask the run's real
  // failure). `release.finalized` is the audit PROOF the outcome carries.
  const outcome = await new AllocatorReleaseFinalizer(allocator).finalize(runnerId, reason);
  const cleanedUp = outcome.kind === "released";
  const failure = cleanedUp ? {} : { failureReason: releaseFailureSummary(outcome.message) };
  await appendEvent("release.finalized", {
    runnerId,
    cleanedUp,
    residualResources: cleanedUp ? [] : [`runner:${runnerId}`],
    ...failure,
  });
}

// A NON-SECRET one-line summary of a release failure for the cleanup-proof event. A
// release error is an allocator/HTTP fault message (a runner id, a status, a provider
// message) — never a credential value — but we still bound it to a single line so no
// multi-line provider dump rides along.
function releaseFailureSummary(message: string): string {
  return message.split("\n")[0]?.slice(0, 300) ?? "runner release failed";
}
