// The planner-loop workflow's run-FINALIZE helpers, extracted from
// `plannerRun.ts` (file-size + complexity caps). All terminal `UPDATE runs`
// transitions the workflow drives go through {@link FinalizeRunState}.
//
// Plane-split P3: `buildFinalizeRunState` returns a closure that — when the
// worker injects a remote finalizer (`input.finalizeRun`, remote-writes on) —
// routes the terminal UPDATE through the control-plane endpoint; otherwise it
// runs the SAME in-process UPDATE the workflow always has (the
// `directSql`/`directParams` are byte-identical to the prior write, so the
// default path + its mutation suite are unchanged). The `fromStatuses` guard is
// what the remote endpoint applies for exactly-once.

import type { RunnerAllocation } from "../contracts/allocator.js";
import { CodexUsageLimitError } from "../providers/codex.js";
import type { EventName, EventPayload } from "../events/index.js";
import { WorkspaceBootstrapError } from "../workspace/index.js";
import type { MergeForRunResult } from "./reviewMerge/index.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import type { SubtaskLoopOutcome } from "./subtaskLoop.js";

/** The `runner.allocated` event payload — runner id/image + the SSH target's public fields. */
export function runnerPayload(allocation: RunnerAllocation) {
  return {
    runnerId: allocation.runnerId,
    imageSha: allocation.imageSha,
    target: {
      host: allocation.target.host,
      port: allocation.target.port,
      username: allocation.target.username,
      hostKeyFingerprint: allocation.target.hostKeyFingerprint,
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
 * Plane-split P3c: drive the run's `running` transition, routing through the
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
 * Plane-split P3c: set the spec's status, routing through the lifecycle writer
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
export function runOutcomeFor(outcome: SubtaskLoopOutcome): "window_exhausted" | "retry_budget_exhausted" | "halted" {
  if (outcome.kind === "window_exhausted") {
    return "window_exhausted";
  }
  if (outcome.kind === "retry_budget_exhausted") {
    return "retry_budget_exhausted";
  }
  return "halted";
}

/** Finalize a non-pass loop outcome to a halted run (distinct outcome preserves WHY). */
export async function finalizeNonPass(
  finalizeRunState: FinalizeRunState,
  runId: string,
  outcome: "window_exhausted" | "retry_budget_exhausted" | "halted",
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
 * Finalize the run + spec for the merge stage's terminal outcome:
 *   - conflict → recoverable halt (the conflict event already emitted), spec NOT done;
 *   - failed → run failed;
 *   - merged → run done/ok; spec `merged`;
 *   - queued/handed_off → run done/ok; spec status depends on WHO owns the merge:
 *       - `external_reviewer` / `not_configured` HAND OFF — Tanren is NOT going to
 *         merge, so the spec is `done` (the merge is left to an operator).
 *       - `native_queue` does NOT hand off — Tanren OWNS the merge (the run merely
 *         ENTERED the native queue; the coordinator's DRIVE pass merges it later).
 *         So the spec MUST stay in its pre-merge status (NOT `done`/`merged`) until
 *         that drive merges — otherwise the ordering invariant's two reads
 *         (`mergedSpecIds` + the P2c-1 speculative-hold, both keyed on
 *         `status IN ('done','merged')`) would treat a queued-but-UNMERGED ancestor
 *         as merged and let a dependent merge ahead of it (the cardinal sin).
 * Byte-identical to the inline branches it replaces for every non-native_queue mode.
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
  // P2d: a `native_queue` first-pass `queued` outcome ENTERED the queue but did NOT
  // merge — Tanren still owns the merge, so the spec must NOT become `done`/`merged`
  // here (the coordinator's drive-pass merge sets `merged`). Leave the spec in its
  // in-flight status; only the run finalizes (it successfully enqueued). Every other
  // mode is unchanged: `merged` → `merged`, a hand-off `queued`/`handed_off` → `done`.
  const isNativeQueueEnqueue = outcome === "queued" && integration === "native_queue";
  if (!isNativeQueueEnqueue) {
    const specStatus = outcome === "merged" ? "merged" : "done";
    await setSpecStatus(input, context, specStatus);
  }
  await finalizeRunState(
    "done",
    "ok",
    ["running", "queued"],
    "UPDATE runs SET status = 'done', outcome = 'ok', ended_at = now() WHERE run_id = $1",
    [context.runId],
  );
}

/** The bits the workflow's catch-path error finalizer needs from the run. */
export interface WorkflowErrorContext {
  finalizeRunState: FinalizeRunState;
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>;
  runId: string;
  workspacePath: string;
}

/**
 * Finalize the run for a workflow throw + emit its event. A WorkspaceBootstrap
 * failure or a Codex usage-limit are RECOVERABLE (a halt with a distinct
 * outcome), not a crash; anything else lands the run `failed`. The caller
 * re-throws after this so the worker still fails the job.
 */
export async function finalizeWorkflowError(error: unknown, ctx: WorkflowErrorContext): Promise<void> {
  if (error instanceof WorkspaceBootstrapError) {
    // Dependency install failed: the workspace can't build/test, so the run can't
    // be gated. Surface it as a halting, recoverable outcome (lands on the
    // P2B-0008 recovery surface) rather than a crash, reusing the
    // workspace.failed event + the halted run state.
    await ctx.appendEvent("workspace.failed", { workspacePath: ctx.workspacePath, message: error.message });
    await finalizeNonPass(ctx.finalizeRunState, ctx.runId, "halted");
    return;
  }
  if (error instanceof CodexUsageLimitError) {
    // Authenticated but out of quota mid-loop: a recoverable window state, not a
    // crash (PROJECT_BRIEF §4.3). Record it as such.
    await finalizeNonPass(ctx.finalizeRunState, ctx.runId, "window_exhausted");
    await ctx.appendEvent("usage.window.pressure", {
      provider: "openai",
      slot: "primary",
      usedPercent: 100,
      resetsAt: new Date().toISOString(),
    });
    return;
  }
  await ctx.finalizeRunState(
    "failed",
    "failed",
    ["running", "queued"],
    "UPDATE runs SET status = 'failed', outcome = 'failed', ended_at = now() WHERE run_id = $1",
    [ctx.runId],
  );
}
