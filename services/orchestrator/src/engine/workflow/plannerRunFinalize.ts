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
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import type { PreparedRunWorkspace } from "./plannerRunWorkspace.js";
import type { MergeForRunResult } from "./reviewMerge/index.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
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

/** Maps a non-pass loop outcome to the persisted run.outcome value (all → halted). */
export function runOutcomeFor(outcome: SubtaskLoopOutcome): "window_exhausted" | "convergence_stalled" | "halted" {
  if (outcome.kind === "window_exhausted") {
    return "window_exhausted";
  }
  // SPEC-LOOP REDESIGN: the convergence-stall halt replaces the purged retry-cap halt.
  if (outcome.kind === "convergence_stalled") {
    return "convergence_stalled";
  }
  return "halted";
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
 * NEVER-STRAND the spec when its run finalizes TERMINAL-WITHOUT-MERGE (apex v22
 * run-discipline finding #3). A halted/failed planner run otherwise leaves the SPEC
 * at `in_flight`, which the DagWalker maps to OCCUPYING-A-SLOT — so the walker never
 * re-attempts, and neither operator-API path can recover it (`requeue` only handles
 * `needs_attention`; `runs` only queues from `open`). The spec is permanently stuck.
 *
 * This is the fail-closed, LOUD recovery: park the spec at the terminal
 * `needs_attention` status (freeing its DAG slot, blocking ONLY its dependents) +
 * emit the `dag.spec.needs_attention` event so the parked state reaches a human AND
 * the operator `requeue` endpoint can re-enter it at `open`. An infra failure (e.g.
 * `MissingCredentialError`) thus SURFACES as an explicit ask-for-help rather than
 * silently stranding the spec — the autonomy loop survives a run failure without a
 * human DB poke.
 *
 * The spec-status flip goes through the SAME `setSpecStatus` seam (control-plane when
 * wired, else in-process org-scoped). The `dag.spec.needs_attention` event reuses the
 * `strand` source (one parked-state vocabulary the operator `requeue` reads) with
 * reason `halted_reexec`.
 */
export async function parkSpecNeedsAttentionForHaltedRun(
  input: RunPlannerLoopInput,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  outcome: "window_exhausted" | "convergence_stalled" | "halted" | "failed",
): Promise<void> {
  // The spec is `in_flight` at every halted-run finalize site (the claim set it; the
  // rework re-entry re-set it), so this is the intended `in_flight → needs_attention`
  // transition. Mirrors the merge stage's blocked/handed_off escalation.
  await setSpecStatus(input, context, "needs_attention");
  await appendEvent("dag.spec.needs_attention", {
    source: "strand",
    specId: context.specId,
    reason: "halted_reexec",
    // The run that just halted (its terminal status) — the parked-state halt history.
    terminalRuns: [{ runId: context.runId, status: "halted" }],
    // No bounded re-enqueue counter exists for a run-terminal strand: the run made one
    // halted attempt, so the visible attempt count is 1.
    attempts: 1,
    // The DECISION ask (escalation discipline): "self-heal could not make progress — a
    // human must decide", not "an error occurred".
    message: `run halted (${outcome}); the spec cannot self-heal — requeue after addressing the cause`,
  });
}

/**
 * Finalize a non-pass loop outcome (run → halted) AND park its spec at
 * `needs_attention` (finding #3 never-strand) — the genuine-strand pair used by the
 * planner-loop's non-pass + rework-exhausted exits, which have NO further driver.
 */
export async function finalizeNonPassAndPark(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  outcome: "window_exhausted" | "convergence_stalled" | "halted",
): Promise<void> {
  await finalizeNonPass(finalizeRunState, context.runId, outcome);
  await parkSpecNeedsAttentionForHaltedRun(input, context, appendEvent, outcome);
}

/** Mutable self-heal budget for the pre_merge gate: `used` re-entries out of `max`. */
export interface MergeGateBudget {
  used: number;
  readonly max: number;
}

/**
 * SELF-HEAL (apex v34): apply the BOUNDED merge stage's decision for a FAILED `pre_merge`
 * gate (the bound is `mergeGateSelfHeal` in plannerRunCi.ts). With budget left: seed the
 * carried steering (the failing tier/step/OUTPUT), bump the counter, return the spec to
 * `in_flight` and signal `"rework"` so the loop re-enters the writer. Budget spent:
 * finalize the run halted + park the spec `needs_attention` and signal `"halt"`. Owns the
 * budget + the lifecycle writes here so plannerRun.ts stays under the 500-line cap (and so
 * the loop branches on the single returned signal, not on the budget internals).
 */
export async function applyFailedMergeGate(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  decision: { kind: "rework"; rejection: PlannerRejectionFeedback } | { kind: "halt" },
  seedRejections: PlannerRejectionFeedback[],
  budget: MergeGateBudget,
): Promise<"rework" | "halt"> {
  if (decision.kind === "halt") {
    await finalizeNonPassAndPark(input, finalizeRunState, context, appendEvent, "halted");
    return "halt";
  }
  budget.used += 1;
  seedRejections.push(decision.rejection);
  await setSpecStatus(input, context, "in_flight");
  return "rework";
}

/**
 * Apply a PR review verdict to the planner loop: `approved` → `merge` (proceed to the
 * merge stage); `changes_requested` within the rework budget → seed the reviewer feedback,
 * return the spec to `in_flight`, and signal `rework` (re-enter the writer); otherwise
 * (pending after the poll budget, or changes-requested with the rework budget exhausted) →
 * finalize the run halted + park the spec `needs_attention` and signal `halt`. Mirrors the
 * merge-gate `applyFailedMergeGate` self-heal; extracted to keep plannerRun.ts under cap +
 * its branching out of `runPlannerLoopWorkflow`.
 */
export async function applyReviewVerdict(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  review: { verdict: string; rejection: PlannerRejectionFeedback },
  seedRejections: PlannerRejectionFeedback[],
  withinReworkBudget: boolean,
): Promise<"merge" | "rework" | "halt"> {
  if (review.verdict === "approved") {
    return "merge";
  }
  if (review.verdict === "changes_requested" && withinReworkBudget) {
    seedRejections.push(review.rejection);
    await setSpecStatus(input, context, "in_flight");
    return "rework";
  }
  await finalizeNonPassAndPark(input, finalizeRunState, context, appendEvent, "halted");
  return "halt";
}

/**
 * Finalize the run + spec for the merge stage's terminal outcome:
 *   - conflict → recoverable halt, spec NOT merged;
 *   - blocked/handed_off/non-native queued → spec `needs_attention`, run halted;
 *   - failed → run failed;
 *   - merged → run completed/ok; spec `merged`;
 *   - native_queue queued → run completed/ok, spec NOT merged. The enqueue
 *     succeeded, but Tanren still owns the merge and the coordinator's DRIVE pass
 *     sets the spec `merged` only after the PR actually lands.
 */
export async function finalizeMergeOutcome(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  merge: Pick<MergeForRunResult, "outcome" | "integration">,
): Promise<void> {
  const { outcome, integration } = merge;
  if (outcome === "conflict") {
    await finalizeNonPass(finalizeRunState, context.runId, "halted");
    return;
  }
  if (outcome === "blocked" || outcome === "needs_attention" || outcome === "handed_off") {
    // `blocked` (a recoverable authority hold) / `needs_attention` (a genuine human
    // decision) / `handed_off` all halt the run with the spec parked for the recovery /
    // operator surface — the run is NOT failed (the work survives, never discarded).
    await setSpecStatus(input, context, "needs_attention");
    await finalizeNonPass(finalizeRunState, context.runId, "halted");
    return;
  }
  if (outcome === "failed") {
    await finalizeRunState(
      "failed",
      "failed",
      ["running", "queued"],
      "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
      [context.runId],
    );
    return;
  }
  if (outcome === "queued" && integration !== "native_queue") {
    await setSpecStatus(input, context, "needs_attention");
    await finalizeNonPass(finalizeRunState, context.runId, "halted");
    return;
  }
  if (outcome === "merged") {
    await setSpecStatus(input, context, "merged");
  }
  await finalizeRunState(
    "completed",
    "ok",
    ["running", "queued"],
    "UPDATE runs SET status = 'completed', outcome = 'ok', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
}

/** The bits the workflow's catch-path error finalizer needs from the run. */
export interface WorkflowErrorContext {
  finalizeRunState: FinalizeRunState;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  workspacePath: string;
  // NEVER-STRAND (finding #3): the loop input + run context (`context.runId` is the run
  // id) so a thrown-error finalize can park the SPEC at `needs_attention` (not just the
  // run at halted/failed) — an infra failure (e.g. MissingCredentialError) frees the DAG
  // slot + becomes operator-requeueable instead of stranding at `in_flight` forever.
  input: RunPlannerLoopInput;
  context: PlannerRunContext;
}

/**
 * SELF-HEAL (apex v35): emit the loud `workspace.bootstrap_deferred` event WHEN the
 * workspace-PREP `just bootstrap` (deps install) failed and was DEFERRED to the gate's
 * self-healing path (rather than terminally stranding the spec — see
 * `PreparedRunWorkspace.prepBootstrapDeferred` + `prepareRunWorkspace`). A no-op when the
 * prep bootstrap succeeded (or was a no-op). The mise PROVISION step is NOT writer-fixable
 * and already threw terminally inside `prepareRunWorkspace` (→ `finalizeWorkflowError`) — it
 * never produces this signal. The command is prelude-free + the output tail bounded
 * (substrate boundary), so no app-secret value reaches the payload.
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
 * Finalize the run for a workflow throw + emit its event. A WorkspaceBootstrap
 * failure or a Codex usage-limit are RECOVERABLE (a halt with a distinct
 * outcome), not a crash; anything else lands the run `failed`. The caller
 * re-throws after this so the worker still fails the job.
 *
 * NEVER-STRAND (finding #3): EVERY branch also parks the SPEC at `needs_attention`
 * via {@link parkSpecNeedsAttentionForHaltedRun}, so a thrown error (recoverable OR a
 * hard `failed`, including an infra `MissingCredentialError`) leaves the spec in a
 * non-occupying, operator-requeueable state — never `in_flight` with a dead run.
 */
export async function finalizeWorkflowError(error: unknown, ctx: WorkflowErrorContext): Promise<void> {
  if (error instanceof WorkspaceBootstrapError) {
    // Dependency install failed: the workspace can't build/test, so the run can't
    // be gated. Surface it as a halting, recoverable outcome (lands on the
    // recovery surface) rather than a crash, reusing the
    // workspace.failed event + the halted run state.
    //
    // RESIDUAL SAFETY NET (apex v35): the workspace-PREP `just bootstrap` deps-install no
    // longer ESCAPES as this error — a writer-fixable failure there is now caught in
    // `prepareRunWorkspace` and DEFERRED to the gate's self-healing path (it emits
    // `workspace.bootstrap_deferred`, never reaching here). This branch remains the
    // fail-closed handler for any other `WorkspaceBootstrapError` that escapes the loop.
    await ctx.appendEvent("workspace.failed", { workspacePath: ctx.workspacePath, message: error.message });
    await finalizeNonPass(ctx.finalizeRunState, ctx.context.runId, "halted");
    await parkSpecNeedsAttentionForHaltedRun(ctx.input, ctx.context, ctx.appendEvent, "halted");
    return;
  }
  if (error instanceof CodexUsageLimitError) {
    // Authenticated but out of quota mid-loop: a recoverable window state, not a
    // crash (PROJECT_BRIEF §4.3). Record it as such.
    await finalizeNonPass(ctx.finalizeRunState, ctx.context.runId, "window_exhausted");
    await ctx.appendEvent("usage.window.pressure", {
      provider: "openai",
      slot: "primary",
      usedPercent: 100,
      resetsAt: new Date().toISOString(),
    });
    await parkSpecNeedsAttentionForHaltedRun(ctx.input, ctx.context, ctx.appendEvent, "window_exhausted");
    return;
  }
  await ctx.finalizeRunState(
    "failed",
    "failed",
    ["running", "queued"],
    "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
    [ctx.context.runId],
  );
  await parkSpecNeedsAttentionForHaltedRun(ctx.input, ctx.context, ctx.appendEvent, "failed");
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
// "Release events prove cleanup and list residual resources, if any."). The runner is
// an untrusted-code surface; the audit trail must record WHETHER its run-end teardown
// actually succeeded, not assume it. `runner.released` narrates the intent;
// `release.finalized` is the PROOF — `cleanedUp: false` with the runner listed as a
// residual resource (+ a non-secret `failureReason`) when the release throws, so an
// orphan sweeper / operator can reconcile the leak. This is the audit EVENT only — the
// allocator still owns the destroy/wipe mechanism. Lives here (a module plannerRun.ts
// already imports) so the run keeps its dependency count under the cap.
//
// Called from the run's `finally`, so it MUST NOT re-throw: a throw would mask the
// run's real failure (the catch already finalized + re-raised it). The event is the
// loud record of a failed teardown WITHOUT swallowing the original error.
//
// `runWorkspace` is layer 1 of the run-sandbox disk-leak fix (≈204 GB incident):
// BEFORE the runner is released, the run's `/workspace/runs/<runId>` dir is removed
// over SSH. On a STATIC / long-lived reused runner `/workspace` survives every run,
// so this is the inline reclaim of the run's clone+build tree; on an EPHEMERAL runner
// the release destroys the volume anyway (the `rm` is then a cheap, harmless no-op
// against a soon-dead container). The removal NEVER throws — a failed `rm` is logged
// and tolerated, exactly like the release leak, so it cannot mask the run's outcome.
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
