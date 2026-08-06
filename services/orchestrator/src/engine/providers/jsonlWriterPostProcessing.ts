import { createLogger } from "../observability/logger.js";
import type { JsonlObjectDecodeError } from "./findTokenUsage.js";
import type { WriterResult } from "./types.js";
const log = createLogger("jsonl-writer-post-processing");
// The shape the writer git-capture returns. It carries the commit-gate fields the capture
// now derives — `exitReason` (completed vs commit_rejected) and the optional `commitRejection`
// steering payload (#1420 commit-gate feedback) — so this seam must preserve them, not narrow
// them away. The failure exitReasons (timeout/crashed/window_exhausted) are the adapter's to
// assign later, so only the two the capture itself can produce appear here.
type GitState = Pick<WriterResult, "diff" | "commits" | "commitRejection"> & {
  exitReason: Extract<WriterResult["exitReason"], "completed" | "commit_rejected">;
};
type WriterTelemetry = NonNullable<WriterResult["telemetry"]>;
type JsonlWriterProvider = "claude" | "codex" | "opencode" | "reasonix";
// Runs the writer's git-capture post-processing and returns the captured git
// state. A JSONL decode failure is TERMINAL for a completed run, but the caller
// classifies it AFTER the recoverable stall / usage-limit checks — so a transient
// stall that left partial (truncated, hence malformed) stdout is reported as the
// recoverable `timeout`/`window_exhausted` the recovery layer re-drives, NOT a
// terminal `crashed`. When a decode failure is present we still capture git
// evidence best-effort, tolerating a capture failure (returning empty git state)
// so the decode-failure telemetry is never lost.
//
// The commit-gate fields the git capture now returns (`exitReason`, `commitRejection`) flow
// THROUGH this seam unchanged on the normal path — the wide `GitState` above is preserved
// rather than narrowed. On the decode-failure-AND-capture-failed branch the run is then
// classified `crashed` (reading only diff/commits), so the placeholder `exitReason: completed`
// on the empty evidence is never surfaced.
export async function postProcessPreservingJsonlFailure(
  provider: JsonlWriterProvider,
  telemetry: WriterTelemetry,
  postProcess: () => Promise<GitState>,
): Promise<GitState> {
  if (telemetry.jsonlDecodeFailure === undefined) {
    return await postProcess();
  }
  try {
    return await postProcess();
  } catch {
    log.error("writer post-processing failed after JSONL decode failure; returning uncaptured Git evidence", {
      provider,
    });
    return { diff: "", commits: [], exitReason: "completed" };
  }
}
export async function postProcessAnswererPreservingJsonlFailure(
  failure: JsonlObjectDecodeError | undefined,
  postProcess: () => Promise<void>,
): Promise<void> {
  try {
    await postProcess();
  } catch (error) {
    throw failure ?? error;
  }
  if (failure !== undefined) throw failure;
}
