/**
 * writerCommitGate — the seam that turns the PROJECT's commit gate from a
 * run-killing exception into writer steering.
 *
 * WHY THIS EXISTS
 *
 * The CLI writer adapters edit the workspace in place; Tanren commits afterwards
 * (`writerGit.captureGitStateAfterWriter` / `codexGit.captureGitStateAfterCodex`).
 * That commit deliberately leaves the repository's hook path LIVE, because it
 * carries the writer's content into the PR — so the project's `pre-commit` hook
 * (lint, format, spell-check, typecheck, whatever the project declares) gets a
 * vote on Tanren's output. Keeping that vote is the whole point; #1407 already
 * argued that silencing it would make Tanren's output the only content in the
 * repo the project's gate never saw.
 *
 * But a NO vote used to be fatal. `runWorkspaceSshCommand` throws on any nonzero
 * exit, nothing on the path from the commit up to `plannerRun` catches it, and
 * `runStageBodyWithFinalizeGuard` re-throws after marking the row failed. So a
 * hook rejection escaped the subtask loop entirely: the run died as
 * `run.failed { failureCode: "workspace" }`, every passed subtask and all
 * convergence state was discarded, and run-end accounting never ran. The writer
 * never learned that anything was wrong — the one agent that could have fixed it
 * in a single edit was already gone.
 *
 * That is backwards. A commit rejected by the project's own quality gate is the
 * MOST actionable failure a writer can receive: deterministic, local, reproducible,
 * and self-describing — it names the files, the lines, and the rule. It is the same
 * class of signal as a failed gate tier, which the subtask loop already feeds back
 * to the writer as steering (`subtaskInnerLoop.gateReason`). This module classifies
 * the commit's failure so the adapters can report it as `exitReason:
 * "commit_rejected"` and the loop can re-drive the writer with the hook's own
 * output, under the SAME convergence budget that governs a failed gate tier.
 *
 * WHAT IS AND IS NOT A VERDICT
 *
 * Only a genuine NONZERO EXIT is the hook's verdict. `runWorkspaceSshCommand` also
 * throws when the substrate itself failed (`result.failure`) or when the activity
 * watchdog saw no sign of life (`result.stalled`). Those are INFRASTRUCTURE faults
 * — the hook never rendered a judgment — and laundering them into "the writer's
 * work is bad" would send the writer chasing a defect that is not in its diff,
 * burning iterations against an unfixable condition. They keep propagating as
 * fatal, exactly as before. This distinction is the sharpest edge in the module.
 */
import type { CommandResult } from "../contracts/commandSubstrate.js";
import { WorkspaceCommandError } from "../workspace/index.js";
import type { CommitRejection } from "./types.js";

/**
 * The bound on the hook report handed back to the writer. Generous next to the
 * 2KB stderr tail on the error message, because this text is the writer's ONLY
 * view of the rejection and a monorepo lint/spell-check run legitimately lists
 * many files. Still bounded: the steering rides in the writer's prompt and in a
 * durable event payload, so an unbounded pathological hook must not balloon
 * either. The TAIL is kept — tooling prints its summary and its verdict last.
 */
export const COMMIT_REJECTION_OUTPUT_LIMIT = 8_000;

/**
 * Combine the rejected commit's stdout and stderr into the report the writer sees.
 *
 * BOTH streams, deliberately. Lint, formatter and spell-check tooling routinely
 * writes its FINDINGS to stdout and only a terse epilogue ("hook failed") to
 * stderr — the live rejection that motivated this module put the
 * `Unknown word (TREATMENTX)` lines, the ones naming the exact fix, on one stream
 * and `husky - pre-commit script failed (code 1)` on the other. A stderr-only
 * capture (what the thrown error's message carries) would feed the writer the
 * epilogue and drop the actionable part.
 */
export function commitRejectionOutput(result: CommandResult): string {
  const combined = [result.stdout, result.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== "")
    .join("\n");
  // Unconditional tail slice rather than a length test + branch: for anything at or under
  // the limit the slice is the identity, so the branch was not just redundant but
  // untestable (either arm produced byte-identical output — a pair of equivalent mutants).
  return combined.slice(Math.max(0, combined.length - COMMIT_REJECTION_OUTPUT_LIMIT));
}

/**
 * Classify a throw from the commit command.
 *
 * Returns a `CommitRejection` iff the throw was the project's hook voting NO — a
 * `WorkspaceCommandError` whose result is a plain nonzero exit. Returns
 * `undefined` for everything else (substrate failure, watchdog stall, or any
 * non-`WorkspaceCommandError` throw), which the caller MUST re-throw: those are
 * infrastructure faults, not judgments about the writer's work.
 */
export function classifyCommitRejection(error: unknown): CommitRejection | undefined {
  if (!(error instanceof WorkspaceCommandError)) return undefined;
  const { result } = error;
  // Infrastructure, not a verdict — the hook never got to render one.
  if (result.failure !== undefined || result.stalled === true) return undefined;
  // Defensive: `runWorkspaceSshCommand` only throws on a nonzero exit once the
  // two arms above are excluded, but a `null`/0 exit here would mean the error
  // did not come from the hook, so it is not ours to reinterpret.
  if (result.exitCode === null || result.exitCode === 0) return undefined;
  return {
    label: error.label,
    exitCode: result.exitCode,
    output: commitRejectionOutput(result),
  };
}

/**
 * The terminal `exitReason` for a writer that did not stall, exhaust its window or crash.
 *
 * The project's commit gate votes LAST, and that ordering is the point: a stall, a spent
 * window or a crash EXPLAIN a rejected commit rather than being explained by it (a writer
 * killed mid-edit leaves a half-written tree the hook will obviously refuse), so each of
 * those classifications wins ahead of this one. Only a writer that otherwise finished
 * cleanly can be `commit_rejected` — which is exactly the case where the hook's verdict is
 * about the WORK and is worth handing back to the writer as steering.
 *
 * Shared by all six writer adapters so the ordering rule is written down once.
 */
export function writerExitReasonFor(gitState: { commitRejection?: CommitRejection }): "completed" | "commit_rejected" {
  return gitState.commitRejection === undefined ? "completed" : "commit_rejected";
}

/**
 * Run a workspace commit, converting a hook rejection into a returned value.
 *
 * `commit` is the caller's already-built commit invocation. Any hook NO vote comes
 * back as a `CommitRejection`; anything else re-throws unchanged, so the existing
 * fatal paths (and their error messages) are untouched.
 */
export async function runCommitThroughProjectGate(
  commit: () => Promise<unknown>,
): Promise<CommitRejection | undefined> {
  try {
    await commit();
    return undefined;
  } catch (error) {
    const rejection = classifyCommitRejection(error);
    if (rejection === undefined) throw error;
    return rejection;
  }
}
